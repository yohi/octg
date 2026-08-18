# Incident Runbook: v2 TokenizerController Deployment Failure

## Scope

This runbook covers failures during the `v2` Durable Object deployment that
introduces `TokenizerController`. It applies when:

- The `v2` migration cannot be applied.
- The `TokenizerController` class fails to register.
- The v2-compatible revision (class present but TokenizerDO calls disabled) fails
to deploy or crashes on startup.

In these cases there is no v2-compatible revision to roll back to, so a
**forward-fix** is required.

## Failure Categories

| Category | Symptom | Likely Cause |
|---|---|---|
| Migration failure | `wrangler deploy` fails with migration error | Syntax error in `wrangler.jsonc` migrations; class name mismatch; duplicate `v2` tag |
| Class registration failure | Worker starts but Durable Object class is not registered | Missing `export { TokenizerController }` in `apps/gateway-worker/src/index.ts`; export path mismatch |
| Binding mismatch | Runtime `TOKENIZER_CONTROLLER` is undefined | Missing binding in `wrangler.jsonc`; env type mismatch |
| Startup crash | `TokenizerController` throws during import | `js-tiktoken` import issue; incompatible Workers runtime flag |

## Immediate Response

1. **Stop the deployment pipeline** to avoid partial or repeated failed deploys.
2. **Collect logs** from the failed Worker and Durable Object invocations.
3. **Confirm v1 revision status**. If the previous `v1` revision is still serving
   traffic, monitor error rates. Consider emergency rollback to the `v1`
   revision only if traffic impact is severe; this reintroduces the 1102 CPU
   exhaustion issue for large inputs.

## Forward-Fix Procedure

1. Identify the failure category from logs and `wrangler deploy` output.
2. Fix the root cause in code or configuration:
   - Migration: verify `wrangler.jsonc` syntax and migration tag uniqueness.
   - Class registration: verify `TokenizerController` is exported from
     `apps/gateway-worker/src/index.ts` and referenced in `durable_objects.bindings`.
   - Binding: verify `Env.TOKENIZER_CONTROLLER` and `wrangler.jsonc` binding name
     match.
   - Startup crash: run `npm test` and `npm run typecheck` locally; check for
     module resolution or runtime compatibility issues.
3. Validate locally:
   ```bash
   npm run typecheck
   npm test
   ```
4. Deploy the fix as a **new deployment**. Do not rewrite an already-applied
   migration tag. If the migration itself must change, introduce a new tag such
   as `v3` rather than editing `v2`.
5. Run canary traffic and verify:
   - `TokenizerController` RPC calls succeed.
   - `quota_reserve` and upstream stages follow normal lifecycle.
   - No `exceededCpu` or overload errors appear in Gateway or Tokenizer logs.

## Rollback Criteria

Forward-fix is the default. Roll back to the `v1` revision only when:

- The v2-compatible revision cannot be made healthy quickly enough to prevent
  sustained customer impact.
- The v1 revision is confirmed available and deployable.
- Stakeholders accept the reintroduction of the 1102 large-input CPU issue.

## Validation Checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `wrangler deploy` succeeds in staging.
- [ ] Canary `TokenizerController` RPC succeeds.
- [ ] Quota reservation and upstream lifecycle are normal in canary.

## Escalation

- Engineering lead: notify after 15 minutes of unresolved failure.
- Incident commander: notify if rollback to `v1` is under consideration.
- Cloudflare support: engage for Durable Object migration or binding issues that
  cannot be resolved through configuration changes.
