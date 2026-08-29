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

ruby -ryaml - "$workflow" <<'RUBY'
path = ARGV.fetch(0)

def fail_contract(message)
  warn "workflow contract violation: #{message}"
  exit 1
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

unless push["branches"] == ["master"]
  fail_contract('on.push.branches must be exactly ["master"]')
end

unless pull_request["branches"] == ["master"]
  fail_contract('on.pull_request.branches must be exactly ["master"]')
end

required_paths = [
  "apps/deno-tokenizer/**",
  "packages/shared/**",
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

needs = deploy["needs"]
needs = [needs] if needs.is_a?(String)
unless needs.is_a?(Array) && needs.include?("validate")
  fail_contract('jobs.deploy.needs must include "validate" so deployment cannot bypass validation')
end

expected_if = "github.event_name == 'push' && github.ref == 'refs/heads/master'"
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
  "DENO_DEPLOY_TOKEN" => "${{ secrets.DENO_DEPLOY_TOKEN }}",
}
deploy_env = require_mapping(deploy["env"], "jobs.deploy.env")
expected_env.each do |name, value|
  unless deploy_env[name] == value
    fail_contract("jobs.deploy.env.#{name} must map to #{value}")
  end
end

deploy_step = deploy_steps.find { |step| step.is_a?(Hash) && step["name"] == "Deploy" }
fail_contract('jobs.deploy must have a named "Deploy" step') unless deploy_step
unless deploy_step["working-directory"] == "apps/deno-tokenizer"
  fail_contract('the "Deploy" step must run from apps/deno-tokenizer')
end

deploy_run = deploy_step["run"].to_s
[
  "deno deploy",
  "--prod",
  "--json",
  "--non-interactive",
].each do |fragment|
  unless deploy_run.include?(fragment)
    fail_contract("the \"Deploy\" step is missing: #{fragment}")
  end
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
