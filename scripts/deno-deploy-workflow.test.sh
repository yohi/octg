#!/usr/bin/env bash
set -euo pipefail

workflow="${1:-.github/workflows/deploy-deno-tokenizer.yml}"

if [[ ! -f "$workflow" ]]; then
  printf 'missing workflow: %s\n' "$workflow" >&2
  exit 1
fi

if ! ruby -ryaml -e '' >/dev/null 2>&1; then
  printf 'workflow contract requires Ruby with the standard YAML library\n' >&2
  exit 2
fi

if rg -n '^(import|export) .* from "\./[^"./]+";' packages/shared/src; then
  printf 'Deno Deploy contract violation: shared relative imports must include .ts extensions\n' >&2
  exit 1
fi

if ! ruby -rjson -e 'config = JSON.parse(File.read("deno.json")); exit(config["nodeModulesDir"] == "none" ? 0 : 1)'; then
  printf 'Deno Deploy contract violation: deno.json must set nodeModulesDir to none\n' >&2
  exit 1
fi

if ! ruby -rjson -e 'config = JSON.parse(File.read("apps/deno-tokenizer/package.json")); exit(config.dig("dependencies", "tiktoken") == "1.0.22" ? 0 : 1)'; then
  printf 'Deno Deploy contract violation: apps/deno-tokenizer/package.json must declare tiktoken 1.0.22\n' >&2
  exit 1
fi

ruby -ryaml -rjson -rshellwords - "$workflow" <<'RUBY'
path = ARGV.fetch(0)

def fail_contract(message)
  warn "workflow contract violation: #{message}"
  exit 1
end

begin
  deploy_config = JSON.parse(File.read("deno.json"))
rescue StandardError => error
  fail_contract("invalid deno.json: #{error.message}")
end

def require_mapping(value, name)
  fail_contract("#{name} must be a mapping") unless value.is_a?(Hash)
  value
end

def require_steps(job, name)
  steps = job["steps"]
  fail_contract("#{name}.steps must be a list") unless steps.is_a?(Array)
  steps
end

def run_steps(steps)
  steps.filter_map { |step| step["run"] if step.is_a?(Hash) && step["run"].is_a?(String) }
end

def parenthesized_content(text, opening)
  nesting = 1
  cursor = opening + 1
  quote = nil
  while cursor < text.length && nesting.positive?
    char = text[cursor]
    if quote
      quote = nil if char == quote && text[cursor - 1] != "\\"
    elsif ["'", '"'].include?(char)
      quote = char
    elsif char == "("
      nesting += 1
    elsif char == ")"
      nesting -= 1
    end
    cursor += 1
  end
  nesting.zero? ? [text[(opening + 1)...(cursor - 1)], cursor] : [nil, opening + 1]
end

def command_tokens(run, depth = 0)
  return [] if depth > 12

  logical_lines = []
  pending = +""
  run.each_line do |line|
    stripped = line.sub(/\s+#.*$/, "").rstrip
    if stripped.end_with?("\\")
      pending << stripped.delete_suffix("\\") << " "
    else
      logical_lines << pending + stripped
      pending = +""
    end
  end
  logical_lines << pending unless pending.empty?

  logical_lines.flat_map do |line|
    begin
      nested_commands = []
      flattened = +""
      quote = nil
      escaped = false
      index = 0
      while index < line.length
        char = line[index]
        if escaped
          flattened << char
          escaped = false
        elsif char == "\\" && quote != "'"
          flattened << char
          escaped = true
        elsif quote == '"' && char == "$" && line[index + 1] == "("
          content, cursor = parenthesized_content(line, index + 1)
          if content
            nested_commands.concat(command_tokens(content, depth + 1))
            flattened << " "
            index = cursor - 1
          else
            flattened << char
          end
        elsif quote
          flattened << char
          quote = nil if char == quote
        elsif ["'", '"'].include?(char)
          quote = char
          flattened << char
        elsif char == "(" || (char == "$" && line[index + 1] == "(")
          opening = char == "$" ? index + 1 : index
          content, cursor = parenthesized_content(line, opening)
          if content
            nested_commands.concat(command_tokens(content, depth + 1))
            flattened << " "
            index = cursor - 1
          else
            flattened << char
          end
        elsif [";", "|"].include?(char) || (char == "&" && line[index + 1] == "&") || (char == "|" && line[index + 1] == "|")
          operator = line[index, 2] == "&&" || line[index, 2] == "||" ? line[index, 2] : char
          flattened << " #{operator} "
          index += operator.length - 1
        elsif (word = line[index..].match(/\A(?:if|then|elif|else|fi|while|do|done|for|in)\b/))
          flattened << " #{word[0]} "
          index += word[0].length - 1
        else
          flattened << char
        end
        index += 1
      end

      tokens = Shellwords.shellsplit(flattened)
      separators = %w[&& || ; | if then elif else fi while do done for in]
      segments = []
      current = []
      tokens.each do |token|
        if separators.include?(token)
          segments << current unless current.empty?
          current = []
        else
          current << token
        end
      end
      segments << current unless current.empty?
      nested_commands + segments
    rescue ArgumentError
      []
    end
  end
end

def forbidden_production_command?(run)
  tokens = command_tokens(run)
  tokens.any? do |segment|
    command_index = segment.index do |token|
      !token.match?(/\A[A-Za-z_][A-Za-z0-9_]*=/) && !%w[env sudo command].include?(File.basename(token))
    end
    next false unless command_index
    command = File.basename(segment[command_index])
    next false unless %w[deno wrangler].include?(command)

    args = segment[(command_index + 1)..]
    next true if command == "deno" && args[0] == "deploy"
    next true if command == "wrangler" && args[0] == "deploy"
    next true if command == "wrangler" && args[0] == "secret" && args[1] == "put"
    next true if command == "wrangler" && args[0] == "versions" && %w[upload deploy].include?(args[1])
    next true if command == "wrangler" && args[0] == "versions" && args[1] == "secret" && args[2] == "delete"
    next true if command == "wrangler" && args[0] == "d1" && args[1] == "migrations" && args[2] == "apply"

    if command == "deno" && args[0] == "run" && args[1] == "-A" && args[2].to_s.start_with?("jsr:@deno/deploy@")
      subcommands = args.drop(3)
      next true if subcommands[0] == "deploy"
      next true if subcommands[0] == "env" && subcommands[1] == "load"
    end
    false
  end
end

begin
  workflow = YAML.safe_load(File.read(path), aliases: true)
rescue StandardError => error
  fail_contract("invalid YAML: #{error.message}")
end

require_mapping(workflow, "workflow")
# Psych treats GitHub Actions' unquoted `on` as a boolean under YAML 1.1.
triggers = workflow["on"] || workflow[true]
require_mapping(triggers, "on")

push = require_mapping(triggers["push"], "on.push")
pull_request = require_mapping(triggers["pull_request"], "on.pull_request")
unless triggers.key?("workflow_dispatch")
  fail_contract("on.workflow_dispatch must be configured for pre-merge deployment verification")
end
pull_request_types = pull_request["types"]
unless pull_request_types.is_a?(Array) && pull_request_types.include?("labeled")
  fail_contract('on.pull_request.types must include "labeled" for pre-merge deployment verification')
end

unless push["branches"] == ["master"]
  fail_contract('on.push.branches must be exactly ["master"]')
end

unless pull_request["branches"] == ["master"]
  fail_contract('on.pull_request.branches must be exactly ["master"]')
end

required_paths = [
  "deno.json",
  "apps/deno-tokenizer/**",
  "packages/shared/**",
  "scripts/deno-deploy-failure-diagnostics.mjs",
  ".github/workflows/deploy-deno-tokenizer.yml",
]

pull_request_paths = pull_request["paths"]
fail_contract("on.pull_request.paths must be a list") unless pull_request_paths.is_a?(Array)

missing_paths = required_paths - pull_request_paths
unless missing_paths.empty?
  fail_contract("on.pull_request.paths is missing: #{missing_paths.join(", ")}")
end

if push.key?("paths")
  fail_contract("on.push.paths must be absent so every master commit deploys the Deno revision")
end

jobs = require_mapping(workflow["jobs"], "jobs")
validate = require_mapping(jobs["validate"], "jobs.validate")
deploy = require_mapping(jobs["deploy"], "jobs.deploy")
require_mapping(jobs["deploy-production"], "jobs.deploy-production")

[workflow["permissions"], *jobs.values.map { |job| job["permissions"] }].compact.each do |permissions|
  if permissions.is_a?(Hash) && permissions["id-token"] == "write"
    fail_contract("id-token: write is not allowed for Deno Deploy")
  end
end

validate_steps = require_steps(validate, "jobs.validate")
deploy_steps = require_steps(deploy, "jobs.deploy")

validate_defaults = require_mapping(validate["defaults"], "jobs.validate.defaults")
validate_run_defaults = require_mapping(
  validate_defaults["run"],
  "jobs.validate.defaults.run",
)
unless validate_run_defaults["working-directory"] == "apps/deno-tokenizer"
  fail_contract("jobs.validate.defaults.run.working-directory must be apps/deno-tokenizer")
end

validate_runs = run_steps(validate_steps)
validate_steps.each_with_index do |step, index|
  next unless step.is_a?(Hash) && step["run"].is_a?(String)
  if forbidden_production_command?(step["run"])
    fail_contract("jobs.validate.steps[#{index}] contains a direct Production mutation command")
  end
end
unless validate_runs.any? { |run| run.include?("deno install") }
  fail_contract("jobs.validate must install Deno dependencies")
end
unless validate_runs.any? { |run| run.include?("deno task check") }
  fail_contract("jobs.validate must run deno task check")
end
unless validate_runs.any? { |run| run.include?("deno task test") }
  fail_contract("jobs.validate must run deno task test")
end
node_dependencies_step = validate_steps.find do |step|
  step.is_a?(Hash) && step["run"].to_s.include?("npm ci")
end
fail_contract("jobs.validate must install Node dependencies") unless node_dependencies_step
unless node_dependencies_step["working-directory"] == "${{ github.workspace }}"
  fail_contract("Node dependency installation must run from the repository root")
end
workflow_test_step = validate_steps.find do |step|
  step.is_a?(Hash) && step["run"].to_s.include?("npm run test:deno-deploy-workflow")
end
fail_contract("jobs.validate must run the Deno Deploy workflow contract test") unless workflow_test_step
node_dependencies_index = validate_steps.index(node_dependencies_step)
workflow_test_index = validate_steps.index(workflow_test_step)
unless node_dependencies_index < workflow_test_index
  fail_contract("jobs.validate must install Node dependencies before running the workflow contract test")
end
unless workflow_test_step["working-directory"] == "${{ github.workspace }}"
  fail_contract("the workflow contract test must run from the repository root")
end

unless validate_steps.any? { |step| step.is_a?(Hash) && step["uses"].to_s.start_with?("denoland/setup-deno@") }
  fail_contract("jobs.validate must use denoland/setup-deno")
end
unless deploy_steps.any? { |step| step.is_a?(Hash) && step["uses"].to_s.start_with?("denoland/setup-deno@") }
  fail_contract("jobs.deploy must use denoland/setup-deno")
end

expected_deno_version = "v2.9.6"
expected_deploy_cli = "deno run -A jsr:@deno/deploy@0.0.9904"
{"validate" => validate_steps, "deploy" => deploy_steps}.each do |job_name, steps|
  setup_step = steps.find { |step| step.is_a?(Hash) && step["uses"].to_s.start_with?("denoland/setup-deno@") }
  setup_with = require_mapping(setup_step["with"], "jobs.#{job_name} denoland/setup-deno.with")
  unless setup_with["deno-version"] == expected_deno_version
    fail_contract("jobs.#{job_name} must pin denoland/setup-deno to #{expected_deno_version}")
  end
end

needs = deploy["needs"]
needs = [needs] if needs.is_a?(String)
unless needs.is_a?(Array) && needs.include?("validate")
  fail_contract('jobs.deploy.needs must include "validate" so deployment cannot bypass validation')
end

%w[deploy deploy-production].each do |job_name|
  job = require_mapping(jobs[job_name], "jobs.#{job_name}")
  unless job["if"] == false
    fail_contract("jobs.#{job_name}.if must be the fixed unconditional deny false during HOLD")
  end
end

unless deploy["environment"] == "deno-production"
  fail_contract('jobs.deploy.environment must be "deno-production"')
end

concurrency = require_mapping(deploy["concurrency"], "jobs.deploy.concurrency")
unless concurrency["group"] == "deno-tokenizer-production" && concurrency["cancel-in-progress"] == false
  fail_contract("jobs.deploy.concurrency must serialize Production deployments without cancellation")
end

effective_permissions = deploy.key?("permissions") ? deploy["permissions"] : workflow["permissions"]
effective_permissions = require_mapping(effective_permissions, "effective deploy permissions")
unless effective_permissions["contents"] == "read"
  fail_contract("effective jobs.deploy.permissions.contents must be read")
end

expected_env = {
  "DENO_DEPLOY_ORG" => "${{ vars.DENO_DEPLOY_ORG }}",
  "DENO_DEPLOY_APP" => "${{ vars.DENO_DEPLOY_APP }}",
}
deploy_env = require_mapping(deploy["env"], "jobs.deploy.env")
expected_env.each do |name, value|
  unless deploy_env[name] == value
    fail_contract("jobs.deploy.env.#{name} must map to #{value}")
  end
end

jobs.each do |job_name, raw_job|
  job = require_mapping(raw_job, "jobs.#{job_name}")
  if job.key?("uses")
    unless job["uses"].is_a?(String) && !job["uses"].empty?
      fail_contract("jobs.#{job_name}.uses must be a non-empty string")
    end
    if job.key?("steps")
      fail_contract("jobs.#{job_name} must not define steps alongside uses")
    end
    next
  end
  require_steps(job, "jobs.#{job_name}").each_with_index do |step, index|
    next unless step.is_a?(Hash)
    next if job_name == "deploy" && [
      "Configure Deno tokenizer runtime Secret",
      "Deploy",
      "Classify failed revision",
    ].include?(step["name"])

    step_env = step["env"]
    next unless step_env.is_a?(Hash)
    if step_env.key?("DENO_DEPLOY_TOKEN")
      fail_contract("jobs.#{job_name}.steps[#{index}] must not define DENO_DEPLOY_TOKEN")
    end
  end
end

if deploy_env.key?("DENO_DEPLOY_TOKEN")
  fail_contract("DENO_DEPLOY_TOKEN must be scoped to the Deploy step")
end

deploy_step = deploy_steps.find { |step| step.is_a?(Hash) && step["name"] == "Deploy" }
fail_contract('jobs.deploy must have a named "Deploy" step') unless deploy_step
deploy_step_index = deploy_steps.index(deploy_step)

runtime_secret_step = deploy_steps.find do |step|
  step.is_a?(Hash) && step["name"] == "Configure Deno tokenizer runtime Secret"
end
fail_contract('jobs.deploy must configure the Deno runtime authentication Secret') unless runtime_secret_step
runtime_secret_index = deploy_steps.index(runtime_secret_step)
unless runtime_secret_index < deploy_step_index
  fail_contract('the Deno runtime Secret must be configured before "Deploy"')
end
runtime_secret_env = require_mapping(
  runtime_secret_step["env"],
  'the "Configure Deno tokenizer runtime Secret" step env',
)
unless runtime_secret_env["DENO_DEPLOY_TOKEN"] == "${{ secrets.DENO_DEPLOY_TOKEN }}"
  fail_contract('the runtime Secret step must scope DENO_DEPLOY_TOKEN to the step')
end
unless runtime_secret_env["PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN"] == "${{ secrets.PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN }}"
  fail_contract('the runtime Secret step must receive the shared Production tokenizer Secret')
end
runtime_secret_run = runtime_secret_step["run"].to_s
[
  "OCTG_TOKENIZER_AUTH_TOKEN",
  "deno run -A jsr:@deno/deploy@0.0.9904",
  "env load",
  "--replace",
  "mode: 0o600",
].each do |fragment|
  unless runtime_secret_run.include?(fragment)
    fail_contract('the runtime Secret step is missing: ' + fragment)
  end
end
if runtime_secret_run.include?("${{ secrets.PRODUCTION_DENO_TOKENIZER_AUTH_TOKEN }}")
  fail_contract('the runtime Secret step must not interpolate Secret expressions in run')
end

relay_var_names = [
  "OCTG_RELAY_ENABLED",
  "OCTG_RELAY_ENVIRONMENT",
  "OCTG_RELAY_CALLBACK_ORIGIN",
  "OCTG_RELAY_GATEWAY_B_BASE_URL",
  "OCTG_RELAY_MAX_REQUEST_DURATION_MS",
  "OCTG_RELAY_LEASE_TTL_MS",
  "OCTG_RELAY_LEASE_RENEWAL_INTERVAL_MS",
]
relay_var_names.each do |name|
  unless runtime_secret_env[name] == "${{ vars.#{name} }}"
    fail_contract("the runtime Secret step must receive #{name} from GitHub Variables")
  end
end

relay_secret_names = [
  "PRODUCTION_OCTG_RELAY_SERVICE_AUTH_TOKEN",
  "PRODUCTION_OCTG_RELAY_INGRESS_AUTH_TOKEN",
  "PRODUCTION_OCTG_RELAY_GATEWAY_B_TOKEN",
]
relay_secret_names.each do |name|
  unless runtime_secret_env[name] == "${{ secrets.#{name} }}"
    fail_contract("the runtime Secret step must receive #{name} from GitHub Secrets")
  end
end

unless runtime_secret_run.include?("OCTG_RELAY_ENABLED")
  fail_contract('the runtime Secret step must conditionally load relay runtime variables')
end
unless runtime_secret_run.include?("PRODUCTION_OCTG_RELAY_SERVICE_AUTH_TOKEN")
  fail_contract('the runtime Secret step must reference relay service Secret for env load')
end
unless runtime_secret_run.include?("PRODUCTION_OCTG_RELAY_INGRESS_AUTH_TOKEN")
  fail_contract('the runtime Secret step must reference relay ingress Secret for env load')
end
unless runtime_secret_run.include?("PRODUCTION_OCTG_RELAY_GATEWAY_B_TOKEN")
fail_contract('the runtime Secret step must reference Gateway B Secret for env load')
end
if runtime_secret_run.include?("OCTG_RELAY_SERVICE_AUTH_TOKEN must be configured")
  fail_contract('the runtime Secret step must validate the production-prefixed relay service Secret name, not the runtime name')
end

unless deploy_step["id"] == "deploy"
  fail_contract('the "Deploy" step must have id "deploy" for failed revision diagnostics')
end
deploy_step_env = require_mapping(deploy_step["env"], 'the "Deploy" step env')
unless deploy_step_env["DENO_DEPLOY_TOKEN"] == "${{ secrets.DENO_DEPLOY_TOKEN }}"
  fail_contract('the "Deploy" step must map DENO_DEPLOY_TOKEN to the environment secret')
end
unless deploy_step["working-directory"] == "${{ github.workspace }}/.deno-deploy-source"
  fail_contract('the "Deploy" step must run from the staged source directory')
end

deploy_run = deploy_step["run"].to_s
[
  expected_deploy_cli,
  "--prod",
  "--json",
  "--non-interactive",
].each do |fragment|
  unless deploy_run.include?(fragment)
    fail_contract("the \"Deploy\" step is missing: #{fragment}")
  end
end

if deploy_run.lines.any? { |line| line.match?(/^\s*deno\s+deploy\b/i) }
  fail_contract('the "Deploy" step must bypass the Deno 2.9.6 wrapper that duplicates passthrough arguments')
end

[
  '--org "$DENO_DEPLOY_ORG"',
  '--app "$DENO_DEPLOY_APP"',
].each do |fragment|
  if deploy_run.include?(fragment)
    fail_contract("the \"Deploy\" step must use Deno Deploy environment variables instead of #{fragment}")
  end
end

if deploy_run.match?(/\bdeno\s+deploy\s+\./)
  fail_contract('the "Deploy" step must not pass a positional root path to deno deploy')
end

diagnostic_step = deploy_steps.find do |step|
  step.is_a?(Hash) && step["name"] == "Classify failed revision"
end
fail_contract('jobs.deploy must classify a failed Deno Deploy revision') unless diagnostic_step
diagnostic_step_index = deploy_steps.index(diagnostic_step)
unless deploy_step_index < diagnostic_step_index
  fail_contract('the failed revision classifier must run after "Deploy"')
end

diagnostic_if = diagnostic_step["if"].to_s
unless diagnostic_if.include?("failure()") && diagnostic_if.include?("steps.deploy.outputs.revision")
  fail_contract('the failed revision classifier must run only after a Deploy failure with a revision ID')
end

diagnostic_env = require_mapping(diagnostic_step["env"], 'the "Classify failed revision" step env')
unless diagnostic_env["DENO_DEPLOY_TOKEN"] == "${{ secrets.DENO_DEPLOY_TOKEN }}"
  fail_contract('the failed revision classifier must scope DENO_DEPLOY_TOKEN to its step')
end
unless diagnostic_env["DENO_DEPLOY_REVISION"] == "${{ steps.deploy.outputs.revision }}"
  fail_contract('the failed revision classifier must receive the failed Deploy revision ID')
end

diagnostic_run = diagnostic_step["run"].to_s
[
  "node scripts/deno-deploy-failure-diagnostics.mjs classify",
  "deno run -A jsr:@deno/deploy@0.0.9904",
  "logs",
  "node scripts/deno-deploy-failure-diagnostics.mjs classify-runtime",
  "deployments list",
  "node scripts/deno-deploy-failure-diagnostics.mjs summarize-deployment-failure",
].each do |fragment|
  unless diagnostic_run.include?(fragment)
    fail_contract("the failed revision classifier is missing: #{fragment}")
  end
end
if diagnostic_run.match?(/console\.log\([^)]*(?:buildLog|response|text)/)
  fail_contract("the failed revision classifier must not print raw API responses or build logs")
end

unless deploy_run.include?("node \"$GITHUB_WORKSPACE/scripts/deno-deploy-failure-diagnostics.mjs\" extract")
  fail_contract('the "Deploy" step must extract the failed revision with the diagnostics helper')
end
unless deploy_run.include?("node \"$GITHUB_WORKSPACE/scripts/deno-deploy-failure-diagnostics.mjs\" classify-cli")
  fail_contract('the "Deploy" step must classify CLI failures without printing raw output')
end
unless deploy_run.include?('extract <"$RUNNER_TEMP/deno-deploy.log"')
  fail_contract('the "Deploy" step must pipe the CLI log to revision extraction via stdin')
end
unless deploy_run.include?('classify-cli <"$RUNNER_TEMP/deno-deploy.log"')
  fail_contract('the "Deploy" step must pipe the CLI log to classification via stdin')
end
if deploy_run.include?('extract "$RUNNER_TEMP/deno-deploy.log"') ||
    deploy_run.include?('classify-cli "$RUNNER_TEMP/deno-deploy.log"')
  fail_contract('the "Deploy" step must not pass diagnostic paths as CLI arguments')
end
unless deploy_run.include?("status=$?") && deploy_run.include?("exit \"$status\"")
  fail_contract('the "Deploy" step must preserve the deno deploy exit status')
end
if deploy_run.include?("tee")
  fail_contract('the "Deploy" step must not stream raw CLI output to the Actions log')
end

identity_step = deploy_steps.find do |step|
  step.is_a?(Hash) && step["name"] == "Prepare Deno Deploy configuration"
end
fail_contract('jobs.deploy must prepare the Deno Deploy configuration') unless identity_step
identity_step_index = deploy_steps.index(identity_step)
unless identity_step_index < deploy_step_index
  fail_contract('the configuration step must run before "Deploy"')
end
identity_run = identity_step["run"].to_s
unless identity_step["working-directory"] == "."
  fail_contract('the configuration step must run from repository root "."')
end
[
  "DENO_DEPLOY_ORG",
  "DENO_DEPLOY_APP",
  "deploy.org",
  "deploy.app",
  'cp deno.json "$staging/deno.json"',
  'node - "$staging/deno.json"',
  "const path = process.argv[2]",
].each do |fragment|
  unless identity_run.include?(fragment)
    fail_contract("the configuration step is missing: #{fragment}")
  end
end
if identity_run.match?(/const path = ["']deno\.json["']/) ||
    identity_run.match?(/writeFileSync\(\s*["']deno\.json["']/)
  fail_contract("the configuration step must not mutate the checked-out root deno.json")
end
config_copy_index = identity_run.index('cp deno.json "$staging/deno.json"')
config_materialization_index = identity_run.index('node - "$staging/deno.json"')
unless config_copy_index < config_materialization_index
  fail_contract("the configuration step must copy deno.json before materializing deployment identity")
end
if identity_run.include?("DENO_DEPLOY_TOKEN")
  fail_contract("the configuration step must not write DENO_DEPLOY_TOKEN")
end
[
  "GITHUB_WORKSPACE/.deno-deploy-source",
  'mkdir -p "$staging/apps/deno-tokenizer/src" "$staging/packages/shared/src"',
  'cp deno.json',
  'cp -R apps/deno-tokenizer/src',
  'cp -R apps/deno-tokenizer/src/. "$staging/apps/deno-tokenizer/src"',
  'cp -R packages/shared/src',
  'cp -R packages/shared/src/. "$staging/packages/shared/src"',
  'deno check --config "$staging/deno.json"',
  '"$staging/apps/deno-tokenizer/src/main.ts"',
  'deno cache --config apps/deno-tokenizer/deno.json',
  'npm:tiktoken@1.0.22/lite/tiktoken_bg.wasm',
  'import.meta.resolve("tiktoken/lite/tiktoken_bg.wasm")',
  'file://',
  'tiktoken_bg.wasm',
  'fileURLToPath',
  'fs.copyFileSync',
  'config.imports["tiktoken/lite/tiktoken_bg.wasm"]',
  '"./apps/deno-tokenizer/src/tiktoken_bg.wasm"',
].each do |fragment|
  unless identity_run.include?(fragment)
    fail_contract("the staging step is missing: #{fragment}")
  end
end
source_copy_index = identity_run.index('cp -R apps/deno-tokenizer/src')
wasm_copy_index = identity_run.index('fs.copyFileSync')
unless source_copy_index && wasm_copy_index && source_copy_index < wasm_copy_index
  fail_contract('the source tree must be staged before copying the WASM asset')
end
cache_index = identity_run.index('deno cache --config apps/deno-tokenizer/deno.json')
resolve_index = identity_run.index('import.meta.resolve("tiktoken/lite/tiktoken_bg.wasm")')
config_override_index = identity_run.index('config.imports["tiktoken/lite/tiktoken_bg.wasm"]')
unless cache_index && resolve_index && config_override_index &&
    cache_index < config_override_index && resolve_index < config_override_index
  fail_contract('the WASM source must be resolved before overriding the staged import map')
end
staged_config_copy_index = identity_run.index('cp deno.json "$staging/deno.json"')
staged_check_index = identity_run.index('deno check --config "$staging/deno.json"')
unless staged_config_copy_index && staged_check_index && staged_config_copy_index < staged_check_index
  fail_contract('the staged deployment configuration must be checked before deployment')
end

begin
  deploy_config = JSON.parse(File.read("deno.json"))
rescue StandardError => error
  fail_contract("invalid root deno.json: #{error.message}")
end

deploy_config = require_mapping(deploy_config["deploy"], "deno.json.deploy")
if deploy_config.key?("org") || deploy_config.key?("app")
  fail_contract("root deno.json must not hard-code Deno Deploy identity")
end
include_paths = deploy_config["include"]
fail_contract("deno.json.deploy.include must be a list") unless include_paths.is_a?(Array)

required_deploy_paths = [
  "./deno.json",
  "./apps/deno-tokenizer/src/**",
  "./packages/shared/src/**",
]
missing_deploy_paths = required_deploy_paths - include_paths
unless missing_deploy_paths.empty?
  fail_contract("deno.json.deploy.include is missing: #{missing_deploy_paths.join(", ")}")
end
forbidden_deploy_paths = [
  "./package.json",
  "./package-lock.json",
  "./apps/deno-tokenizer/package.json",
]
present_forbidden_paths = forbidden_deploy_paths & include_paths
unless present_forbidden_paths.empty?
  fail_contract("deno.json.deploy.include must not contain: #{present_forbidden_paths.join(", ")}")
end

runtime = require_mapping(deploy_config["runtime"], "deno.json.deploy.runtime")
unless runtime["type"] == "dynamic"
  fail_contract('deno.json.deploy.runtime.type must be "dynamic"')
end
unless runtime["entrypoint"] == "./apps/deno-tokenizer/src/main.ts"
  fail_contract('deno.json.deploy.runtime.entrypoint must be ./apps/deno-tokenizer/src/main.ts')
end

jobs.each do |job_name, raw_job|
  job = require_mapping(raw_job, "jobs.#{job_name}")
  next if job.key?("uses")

  steps = require_steps(job, "jobs.#{job_name}")
  steps.each_with_index do |step, index|
    next unless step.is_a?(Hash)

    uses = step["uses"].to_s
    run = step["run"].to_s
    if uses.match?(/deployctl/i)
      fail_contract("jobs.#{job_name}.steps[#{index}] must not use the retired deployctl action")
    end
    if run.match?(/\bdeployctl\b/i)
      fail_contract("jobs.#{job_name}.steps[#{index}] must not invoke deployctl")
    end
    if job_name != "deploy" && run.match?(/\bdeno\s+deploy\b/i)
      fail_contract("jobs.#{job_name} contains a deployment command before validation")
    end
  end
end
RUBY

if [[ "${OCTG_SKIP_MUTATION_FIXTURES:-false}" != "true" ]]; then
forbidden_fixtures=(
  'deno deploy'
  'deno run -A jsr:@deno/deploy@0.0.9904 deploy'
  'wrangler deploy'
  'wrangler versions upload'
  'wrangler versions deploy'
  'wrangler secret put NAME'
  'wrangler versions secret delete NAME'
  'wrangler d1 migrations apply DB --remote'
  'deno run -A jsr:@deno/deploy@0.0.9904 env load file.env'
  'if true; then wrangler deploy; fi'
  'while true; do wrangler d1 migrations apply DB --remote; done'
  'printf "%s" "$(wrangler secret put NAME)"'
  'printf ok && wrangler versions deploy'
)
for fixture in "${forbidden_fixtures[@]}"; do
  temporary_workflow="$(mktemp)"
  ruby -ryaml - "$workflow" "$temporary_workflow" "$fixture" <<'RUBY'
source, destination, command = ARGV
workflow = YAML.safe_load(File.read(source), aliases: true)
workflow["on"] ||= workflow.delete(true)
workflow.fetch("jobs").fetch("validate").fetch("steps") << { "name" => "injected fixture", "run" => command }
File.write(destination, workflow.to_yaml)
RUBY
  if OCTG_SKIP_MUTATION_FIXTURES=true bash "$0" "$temporary_workflow" >/dev/null 2>&1; then
    rm -f "$temporary_workflow"
    printf 'workflow contract accepted forbidden fixture: %s\n' "$fixture" >&2
    exit 1
  fi
  rm -f "$temporary_workflow"
done

safe_fixtures=(
  '# wrangler deploy is intentionally not executed here'
  "printf '%s\\n' 'wrangler deploy'"
)
for fixture in "${safe_fixtures[@]}"; do
  temporary_workflow="$(mktemp)"
  ruby -ryaml - "$workflow" "$temporary_workflow" "$fixture" <<'RUBY'
source, destination, command = ARGV
workflow = YAML.safe_load(File.read(source), aliases: true)
workflow["on"] ||= workflow.delete(true)
workflow.fetch("jobs").fetch("validate").fetch("steps") << { "name" => "safe parser fixture", "run" => command }
File.write(destination, workflow.to_yaml)
RUBY
  if ! OCTG_SKIP_MUTATION_FIXTURES=true bash "$0" "$temporary_workflow" >/dev/null 2>&1; then
    rm -f "$temporary_workflow"
    printf 'workflow contract rejected safe command fixture: %s\n' "$fixture" >&2
    exit 1
  fi
  rm -f "$temporary_workflow"
done
fi

printf 'Deno Deploy workflow contract: ok\n'
