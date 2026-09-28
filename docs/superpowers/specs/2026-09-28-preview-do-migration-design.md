# Preview Durable Object Migration Before Version Smoke

## Problem

The Preview Smoke workflow applies remote D1 migrations, then uploads a Worker
version. A pull request that adds a Durable Object class migration cannot pass
`wrangler versions upload` until that migration has been applied by a regular
Worker deployment. Cloudflare rejects the version upload with error 10211 when
the Preview Worker has not yet seen the migration.

## Design

After generating the isolated Preview configuration and applying D1 migrations,
deploy the Preview Worker once with `wrangler deploy` using that configuration.
This applies any pending Durable Object migrations through a non-versioned
deployment. Capture the current 100% deployment only after this step, then run
the existing version upload, traffic routing, smoke tests, and restoration
sequence unchanged.

The deployment is limited to the Preview Worker configuration and uses the
existing Preview Cloudflare credentials. The normal deployment may move Preview
traffic to the PR Worker before version smoke begins; this is accepted for the
isolated Preview environment. Test the workflow contract to ensure migration
deployment occurs before current-version capture and version upload.

## Verification

- Run the Preview workflow contract test.
- Run the relevant YAML/workflow checks available in the repository.
- Confirm unrelated pre-existing local changes are not included in the commit.
