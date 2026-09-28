import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPreviewWorkerConfig } from "./preview-worker-config.mjs";

const baseConfig = {
  name: "octg-gateway",
  main: "src/index.ts",
  assets: { directory: "./public" },
  vars: {
    QUOTA_LIMIT_STANDARD: "1000000",
    QUOTA_LIMIT_MINI: "9950000",
    MAX_INPUT_BYTES: "1048576",
    DENO_TOKENIZER_ENDPOINT: "https://production-tokenizer.example/tokenize",
    DENO_TOKENIZER_THRESHOLD_BYTES: "1",
    DENO_TOKENIZER_TIMEOUT_MS: "5000",
    DENO_TOKENIZER_AUTH_TOKEN: "production-auth-secret",
    DENO_PREPARE_ENDPOINT: "https://production-tokenizer.example/prepare",
    DENO_PREPARE_THRESHOLD_BYTES: "1",
    OCTG_RELAY_ENABLED: "true",
    OCTG_RELAY_ENVIRONMENT: "production",
    OCTG_RELAY_INGRESS_ENDPOINT: "https://production-relay.example/relay/v1/responses",
  },
  triggers: { crons: ["5 0 * * *"] },
  durable_objects: {
    bindings: [
      { name: "QUOTA_CONTROLLER", class_name: "QuotaController" },
      { name: "TOKENIZER_CONTROLLER", class_name: "TokenizerController" },
      { name: "RELAY_DECISION_CONTROLLER", class_name: "RelayDecisionController" },
    ],
  },
  migrations: [
    { tag: "v1", new_sqlite_classes: ["QuotaController"] },
    { tag: "v2", new_sqlite_classes: ["TokenizerController"] },
    { tag: "v3", new_sqlite_classes: ["RelayDecisionController"] },
  ],
  d1_databases: [{
    binding: "DB",
    database_name: "octg",
    database_id: "production-database-id",
    migrations_dir: "../../db/migrations",
  }],
};

const validOptions = {
  projectRoot: "/workspace",
  databaseId: "814c8fdb-dc9d-4a83-9065-001729ccd169",
  databaseName: "octg-gateway-preview-db",
  workerName: "octg-gateway-preview",
  upstreamBaseUrl: "https://gateway.example.test/openai",
  standardLimit: "0",
  miniLimit: "50000",
  maxInputBytes: "1048576",
};

test("runs the CLI when the entrypoint path is relative", () => {
  const scriptPath = fileURLToPath(new URL("./preview-worker-config.mjs", import.meta.url));
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const setRelativeArgv = encodeURIComponent("process.argv[1] = 'scripts/preview-worker-config.mjs';");
  const result = spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${setRelativeArgv}`, scriptPath],
    { cwd: projectRoot, encoding: "utf8" },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node scripts\/preview-worker-config\.mjs/);
});

test("builds a DO-only Preview config without Deno values", () => {
  const config = buildPreviewWorkerConfig(baseConfig, validOptions);

  assert.equal(config.name, "octg-gateway-preview");
  assert.equal(config.vars.QUOTA_LIMIT_STANDARD, "0");
  assert.equal(config.vars.QUOTA_LIMIT_MINI, "50000");
  assert.equal(config.vars.MAX_INPUT_BYTES, "1048576");
  assert.equal(config.vars.OCTG_UPSTREAM_BASE_URL, "https://gateway.example.test/openai");
  assert.equal(config.vars.DENO_TOKENIZER_ENDPOINT, undefined);
  assert.equal(config.vars.DENO_TOKENIZER_THRESHOLD_BYTES, undefined);
  assert.equal(config.vars.DENO_TOKENIZER_TIMEOUT_MS, undefined);
  assert.equal(config.vars.DENO_PREPARE_ENDPOINT, undefined);
  assert.equal(config.vars.DENO_PREPARE_THRESHOLD_BYTES, undefined);
  assert.equal(config.vars.OCTG_RELAY_ENABLED, undefined);
  assert.equal(config.vars.OCTG_RELAY_ENVIRONMENT, undefined);
  assert.equal(config.vars.OCTG_RELAY_INGRESS_ENDPOINT, undefined);
  assert.equal(config.triggers, undefined);
  assert.equal(config.d1_databases[0].database_id, validOptions.databaseId);
  assert.notEqual(config, baseConfig);
  assert.equal(baseConfig.vars.DENO_TOKENIZER_ENDPOINT, "https://production-tokenizer.example/tokenize");
  assert.deepEqual(baseConfig.triggers, { crons: ["5 0 * * *"] });
});

test("builds a Deno Preview config only from Preview values", () => {
  const config = buildPreviewWorkerConfig(baseConfig, {
    ...validOptions,
    deno: {
      endpoint: "https://preview-tokenizer.deno.dev/tokenize",
      thresholdBytes: "1",
      timeoutMs: "5000",
    },
  });

  assert.equal(config.vars.DENO_TOKENIZER_ENDPOINT, "https://preview-tokenizer.deno.dev/tokenize");
  assert.equal(config.vars.DENO_TOKENIZER_THRESHOLD_BYTES, "1");
  assert.equal(config.vars.DENO_TOKENIZER_TIMEOUT_MS, "5000");
  assert.equal(config.vars.DENO_TOKENIZER_AUTH_TOKEN, undefined);
  assert.equal(config.vars.DENO_TOKENIZER_ENDPOINT.includes("production"), false);
});

test("maps the Preview input limit and complete prepare pair to Worker bindings", () => {
  const config = buildPreviewWorkerConfig(baseConfig, {
    ...validOptions,
    deno: {
      endpoint: "https://preview-tokenizer.deno.dev/tokenize",
      thresholdBytes: "1",
      timeoutMs: "5000",
    },
    prepare: {
      endpoint: "https://preview-deno.test/prepare",
      thresholdBytes: "700000",
    },
  });

  assert.equal(config.vars.MAX_INPUT_BYTES, "1048576");
  assert.equal(config.vars.DENO_PREPARE_ENDPOINT, "https://preview-deno.test/prepare");
  assert.equal(config.vars.DENO_PREPARE_THRESHOLD_BYTES, "700000");
});

test("omits both generated prepare bindings when the pair is absent", () => {
  const config = buildPreviewWorkerConfig(baseConfig, {
    ...validOptions,
    deno: {
      endpoint: "https://preview-tokenizer.deno.dev/tokenize",
      thresholdBytes: "1",
      timeoutMs: "5000",
    },
    prepare: undefined,
  });

  assert.equal(config.vars.DENO_PREPARE_ENDPOINT, undefined);
  assert.equal(config.vars.DENO_PREPARE_THRESHOLD_BYTES, undefined);
});

test("rejects empty-string prepare placeholders", () => {
  assert.throws(
    () => buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      deno: {
        endpoint: "https://preview-tokenizer.deno.dev/tokenize",
        thresholdBytes: "1",
        timeoutMs: "5000",
      },
      prepare: { endpoint: "", thresholdBytes: "" },
    }),
    /Deno Preview prepare/,
  );
});

test("rejects a one-sided Preview prepare pair", () => {
  assert.throws(
    () => buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      prepare: { endpoint: "https://preview-deno.test/prepare" },
    }),
    /Deno Preview prepare/,
  );
});

test("rejects a complete Preview prepare pair without a tokenizer group", () => {
  assert.throws(
    () => buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      prepare: {
        endpoint: "https://preview-deno.test/prepare",
        thresholdBytes: "700000",
      },
    }),
    /tokenizer/i,
  );
});

test("rejects an invalid Preview input limit", () => {
  assert.throws(
    () => buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      maxInputBytes: "0",
    }),
    /Preview input limit/,
  );
});

test("rejects non-HTTPS or invalid Preview Deno settings", () => {
  for (const deno of [
    { endpoint: "http://preview-tokenizer.deno.dev/tokenize", thresholdBytes: "1", timeoutMs: "5000" },
    { endpoint: "https://user:password@preview-tokenizer.deno.dev/tokenize", thresholdBytes: "1", timeoutMs: "5000" },
    { endpoint: "https://preview-tokenizer.deno.dev/tokenize", thresholdBytes: "0", timeoutMs: "5000" },
    { endpoint: "https://preview-tokenizer.deno.dev/tokenize", thresholdBytes: "1e3", timeoutMs: "5000" },
    { endpoint: "https://preview-tokenizer.deno.dev/tokenize", thresholdBytes: "1", timeoutMs: "0" },
  ]) {
    assert.throws(
      () => buildPreviewWorkerConfig(baseConfig, { ...validOptions, deno }),
      /Deno Preview/,
    );
  }
});

test("rejects a Preview Deno endpoint that is the Production endpoint", () => {
  assert.throws(
    () => buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      deno: {
        endpoint: "https://production-tokenizer.example/tokenize",
        thresholdBytes: "1",
        timeoutMs: "5000",
      },
    }),
    /Production Deno endpoint/,
  );
});

test("rejects Preview endpoints equivalent to the Production endpoint", () => {
  for (const [productionEndpoint, previewEndpoint] of [
    [
      "https://production-tokenizer.example/tokenize",
      "HTTPS://PRODUCTION-TOKENIZER.EXAMPLE/tokenize",
    ],
    [
      "https://production-tokenizer.example:443/tokenize",
      "https://production-tokenizer.example/tokenize",
    ],
  ]) {
    const config = {
      ...baseConfig,
      vars: { ...baseConfig.vars, DENO_TOKENIZER_ENDPOINT: productionEndpoint },
    };
    assert.throws(
      () => buildPreviewWorkerConfig(config, {
        ...validOptions,
        deno: {
          endpoint: previewEndpoint,
          thresholdBytes: "1",
          timeoutMs: "5000",
        },
      }),
      /Production Deno endpoint/,
    );
  }
});

test("rejects Preview prepare endpoints equivalent to the Production endpoint", () => {
  for (const [productionEndpoint, previewEndpoint] of [
    [
      "https://production-tokenizer.example/prepare",
      "HTTPS://PRODUCTION-TOKENIZER.EXAMPLE/prepare",
    ],
    [
      "https://production-tokenizer.example:443/prepare",
      "https://production-tokenizer.example/prepare",
    ],
  ]) {
    const config = {
      ...baseConfig,
      vars: { ...baseConfig.vars, DENO_PREPARE_ENDPOINT: productionEndpoint },
    };
    assert.throws(
      () => buildPreviewWorkerConfig(config, {
        ...validOptions,
        deno: {
          endpoint: "https://preview-tokenizer.deno.dev/tokenize",
          thresholdBytes: "1",
          timeoutMs: "5000",
        },
        prepare: {
          endpoint: previewEndpoint,
          thresholdBytes: "700000",
        },
      }),
      /Production Deno prepare endpoint/,
    );
  }
});

test("preserves Preview endpoint validation for non-string Production endpoints", () => {
  for (const productionEndpoint of [undefined, null, 123]) {
    const config = {
      ...baseConfig,
      vars: { ...baseConfig.vars, DENO_TOKENIZER_ENDPOINT: productionEndpoint },
    };
    assert.doesNotThrow(() => buildPreviewWorkerConfig(config, {
      ...validOptions,
      deno: {
        endpoint: "https://preview-tokenizer.deno.dev/tokenize",
        thresholdBytes: "1",
        timeoutMs: "5000",
      },
    }));
  }
});

test("rejects a Preview quota allocation over the provider ceiling", () => {
  assert.throws(
    () => buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      miniLimit: "10000001",
    }),
    /quota allocation/,
  );
});

test("omits the production Deno auth token from every generated Preview config", () => {
  for (const config of [
    buildPreviewWorkerConfig(baseConfig, validOptions),
    buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      deno: {
        endpoint: "https://preview-tokenizer.deno.dev/tokenize",
        thresholdBytes: "1",
        timeoutMs: "5000",
      },
    }),
  ]) {
    assert.equal(config.vars.DENO_TOKENIZER_AUTH_TOKEN, undefined);
    assert.equal(
      JSON.stringify(config).includes(baseConfig.vars.DENO_TOKENIZER_AUTH_TOKEN),
      false,
    );
  }
});

test("replaces the production input limit with the Preview input limit", () => {
  const config = buildPreviewWorkerConfig(baseConfig, {
    ...validOptions,
    maxInputBytes: "524288",
  });

  assert.equal(config.vars.MAX_INPUT_BYTES, "524288");
  assert.equal(baseConfig.vars.MAX_INPUT_BYTES, "1048576");
  assert.equal(JSON.stringify(config).includes(baseConfig.vars.MAX_INPUT_BYTES), false);
});

test("does not include production Deno or prepare endpoint values in the generated config", () => {
  const config = buildPreviewWorkerConfig(baseConfig, {
    ...validOptions,
    deno: {
      endpoint: "https://preview-tokenizer.deno.dev/tokenize",
      thresholdBytes: "1",
      timeoutMs: "5000",
    },
    prepare: {
      endpoint: "https://preview-deno.test/prepare",
      thresholdBytes: "700000",
    },
  });
  const serialized = JSON.stringify(config);

  assert.equal(serialized.includes(baseConfig.vars.DENO_TOKENIZER_ENDPOINT), false);
  assert.equal(serialized.includes(baseConfig.vars.DENO_PREPARE_ENDPOINT), false);
  assert.equal(serialized.includes("production-tokenizer.example"), false);
});

test("generates the exact Preview-local DO bindings and SQLite migrations without namespace IDs", () => {
  const config = buildPreviewWorkerConfig(baseConfig, validOptions);

  assert.deepEqual(config.durable_objects, {
    bindings: [
      { name: "QUOTA_CONTROLLER", class_name: "QuotaController" },
      { name: "TOKENIZER_CONTROLLER", class_name: "TokenizerController" },
      { name: "RELAY_DECISION_CONTROLLER", class_name: "RelayDecisionController" },
    ],
  });
  assert.deepEqual(config.migrations, [
    { tag: "v1", new_sqlite_classes: ["QuotaController"] },
    { tag: "v2", new_sqlite_classes: ["TokenizerController"] },
    { tag: "v3", new_sqlite_classes: ["RelayDecisionController"] },
  ]);
  assert.equal(JSON.stringify(config).includes("namespace_id"), false);
});

test("rejects a base binding that references a Production namespace ID", () => {
  const config = {
    ...baseConfig,
    durable_objects: {
      bindings: [
        { name: "QUOTA_CONTROLLER", class_name: "QuotaController", namespace_id: "production-namespace-id" },
        { name: "TOKENIZER_CONTROLLER", class_name: "TokenizerController" },
        { name: "RELAY_DECISION_CONTROLLER", class_name: "RelayDecisionController" },
      ],
    },
  };

  assert.throws(
    () => buildPreviewWorkerConfig(config, validOptions),
    /namespace_id/,
  );
});

test("requires every relay Durable Object binding in the base configuration", () => {
  for (const name of ["RELAY_DECISION_CONTROLLER", "QUOTA_CONTROLLER", "TOKENIZER_CONTROLLER"]) {
    const config = {
      ...baseConfig,
      durable_objects: {
        bindings: baseConfig.durable_objects.bindings.filter((binding) => binding.name !== name),
      },
    };

    assert.throws(
      () => buildPreviewWorkerConfig(config, validOptions),
      new RegExp(name),
    );
  }
});

test("rejects a Preview D1 database ID that equals the Production database ID", () => {
  assert.throws(
    () => buildPreviewWorkerConfig(baseConfig, {
      ...validOptions,
      databaseId: baseConfig.d1_databases[0].database_id,
    }),
    /Production database ID/,
  );
});

test("keeps the Production D1 database ID out of the generated Preview config", () => {
  const config = buildPreviewWorkerConfig(baseConfig, validOptions);

  assert.equal(JSON.stringify(config).includes(baseConfig.d1_databases[0].database_id), false);
});

test("strips production relay vars and applies Preview relay config when provided", () => {
  const config = buildPreviewWorkerConfig(baseConfig, {
    ...validOptions,
    deno: {
      endpoint: "https://preview-tokenizer.deno.dev/tokenize",
      thresholdBytes: "1",
      timeoutMs: "5000",
    },
    relay: {
      environment: "preview",
      ingressEndpoint: "https://preview-relay.deno.dev/relay/v1/responses",
    },
  });

  assert.equal(config.vars.OCTG_RELAY_ENABLED, undefined);
  assert.equal(config.vars.OCTG_RELAY_ENVIRONMENT, "preview");
  assert.equal(config.vars.OCTG_RELAY_INGRESS_ENDPOINT, "https://preview-relay.deno.dev/relay/v1/responses");
  assert.equal(baseConfig.vars.OCTG_RELAY_INGRESS_ENDPOINT, "https://production-relay.example/relay/v1/responses");
});

test("rejects invalid Preview relay settings", () => {
  for (const relay of [
    { environment: "staging", ingressEndpoint: "https://preview-relay.deno.dev/relay/v1/responses" },
    { environment: "preview", ingressEndpoint: "http://preview-relay.deno.dev/relay/v1/responses" },
    { environment: "preview", ingressEndpoint: "https://user:pass@preview-relay.deno.dev/relay/v1/responses" },
    { environment: "preview", ingressEndpoint: "https://preview-relay.deno.dev/relay/v1/responses/" },
  ]) {
    assert.throws(
      () => buildPreviewWorkerConfig(baseConfig, { ...validOptions, relay }),
      /Preview relay/,
    );
  }
});

