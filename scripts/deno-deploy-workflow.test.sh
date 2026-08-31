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

ruby -ryaml -rjson - "$workflow" <<'RUBY'
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

{"on.push" => push, "on.pull_request" => pull_request}.each do |name, trigger|
  paths = trigger["paths"]
  fail_contract("#{name}.paths must be a list") unless paths.is_a?(Array)

  missing_paths = required_paths - paths
  unless missing_paths.empty?
    fail_contract("#{name}.paths is missing: #{missing_paths.join(", ")}")
  end
end

jobs = require_mapping(workflow["jobs"], "jobs")
validate = require_mapping(jobs["validate"], "jobs.validate")
deploy = require_mapping(jobs["deploy"], "jobs.deploy")

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
unless validate_runs.any? { |run| run.include?("deno install") }
  fail_contract("jobs.validate must install Deno dependencies")
end
unless validate_runs.any? { |run| run.include?("deno task check") }
  fail_contract("jobs.validate must run deno task check")
end
unless validate_runs.any? { |run| run.include?("deno task test") }
  fail_contract("jobs.validate must run deno task test")
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

expected_if = "(github.event_name == 'push' && github.ref == 'refs/heads/master') || github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.action == 'labeled' && github.event.label.name == 'deploy-deno' && github.event.pull_request.head.repo.full_name == github.repository)"
deploy_if = deploy["if"].to_s.strip
deploy_if = deploy_if.sub(/\A\$\{\{\s*/, "").sub(/\s*\}\}\z/, "")
deploy_if = deploy_if.gsub(/\s+/, " ")
unless deploy_if == expected_if
  fail_contract("jobs.deploy.if must restrict deployment to a master push")
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
  require_steps(job, "jobs.#{job_name}").each_with_index do |step, index|
    next unless step.is_a?(Hash)
    next if job_name == "deploy" && ["Deploy", "Classify failed revision"].include?(step["name"])

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
].each do |fragment|
  unless identity_run.include?(fragment)
    fail_contract("the configuration step is missing: #{fragment}")
  end
end
if identity_run.include?("DENO_DEPLOY_TOKEN")
  fail_contract("the configuration step must not write DENO_DEPLOY_TOKEN")
end
[
  "GITHUB_WORKSPACE/.deno-deploy-source",
  'cp deno.json',
  'cp -R apps/deno-tokenizer/src',
  'cp -R packages/shared/src',
].each do |fragment|
  unless identity_run.include?(fragment)
    fail_contract("the staging step is missing: #{fragment}")
  end
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

printf 'Deno Deploy workflow contract: ok\n'
