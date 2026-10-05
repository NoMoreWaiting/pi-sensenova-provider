import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { __testing as sn } from "../extensions/sensenova.ts";

const {
  PROVIDER_ID,
  BASE_URL,
  RESPONSES_API,
  COMPLETIONS_API,
  IMAGE_API,
  RESPONSES_MODELS,
  GRAMMAR_OUTPUT_MODELS,
  SEED_CATALOG,
  SEED_MODELS,
  toPiModel,
  parseCost,
  extractPromptAndReferences,
  parseImageUsage,
} = sn;

test("provider identity and base url match the official docs", () => {
  assert.equal(PROVIDER_ID, "sensenova");
  assert.equal(BASE_URL, "https://token.sensenova.cn/v1");
});

test("seed catalog mirrors the live /v1/models response shape", () => {
  assert.ok(SEED_CATALOG.length >= 5, "seed catalog should not be empty");
  for (const record of SEED_CATALOG) {
    assert.equal(typeof record.id, "string", `${record.id} has no id`);
    assert.ok(Array.isArray(record.input_modalities), `${record.id} input_modalities`);
    assert.ok(Array.isArray(record.output_modalities), `${record.id} output_modalities`);
    assert.ok(Array.isArray(record.supported_features), `${record.id} supported_features`);
    assert.ok(Number.isFinite(record.context_length) && record.context_length > 0, `${record.id} context_length`);
    assert.ok(Number.isFinite(record.max_output_length) && record.max_output_length > 0, `${record.id} max_output_length`);
  }
});

test("seed catalog ids are unique", () => {
  const ids = SEED_CATALOG.map((record) => record.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("image-output models become image models on the SenseNova image api", () => {
  const model = toPiModel({
    id: "sensenova-u1-fast",
    input_modalities: ["text"],
    output_modalities: ["image"],
    context_length: 262144,
    max_output_length: 65536,
    pricing: {},
  });

  assert.equal(model.type, "image");
  assert.equal(model.api, IMAGE_API);
  assert.equal(model.provider, PROVIDER_ID);
  assert.ok(model.input.includes("image"), "edits accept reference images");
  assert.ok(model.output.includes("image"));
  // Image models must not be mistaken for chat models.
  assert.notEqual(model.reasoning, true);
});

test("Responses-eligible models route to /v1/responses", () => {
  for (const id of RESPONSES_MODELS) {
    const model = toPiModel({
      id,
      input_modalities: ["text"],
      output_modalities: ["text"],
      context_length: 1000,
      max_output_length: 100,
      supported_features: ["tools", "json_mode", "reasoning"],
      pricing: {},
    });
    assert.equal(model.api, RESPONSES_API, `${id} should use the Responses API`);
    // The OpenAI SDK appends /responses itself, so baseUrl stays at the root.
    assert.equal(model.baseUrl, BASE_URL, `${id} baseUrl`);
  }
});

test("models outside the Responses set fall back to chat completions", () => {
  const model = toPiModel({
    id: "deepseek-v4-pro",
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 1048576,
    max_output_length: 65536,
    supported_features: ["tools", "json_mode", "reasoning"],
    pricing: {},
  });
  assert.equal(model.api, COMPLETIONS_API);
  assert.equal(model.baseUrl, BASE_URL);
});

test("chat completions compat disables the developer role and uses max_tokens", () => {
  const model = toPiModel({
    id: "deepseek-v4-pro",
    output_modalities: ["text"],
    context_length: 1000,
    max_output_length: 100,
    supported_features: ["reasoning"],
    pricing: {},
  });
  assert.equal(model.compat.supportsDeveloperRole, false);
  assert.equal(model.compat.maxTokensField, "max_tokens");
  assert.equal(model.compat.thinkingFormat, "deepseek");
  assert.equal(model.compat.supportsReasoningEffort, true);
});

test("reasoning is inferred from supported_features", () => {
  const reasoning = toPiModel({
    id: "glm-5.2",
    output_modalities: ["text"],
    context_length: 1000,
    max_output_length: 100,
    supported_features: ["tools", "json_mode", "reasoning"],
    pricing: {},
  });
  assert.equal(reasoning.reasoning, true);
  assert.ok(reasoning.thinkingLevelMap, "reasoning models get a thinking level map");

  const plain = toPiModel({
    id: "sensenova-mystery",
    output_modalities: ["text"],
    context_length: 1000,
    max_output_length: 100,
    supported_features: ["tools"],
    pricing: {},
  });
  assert.equal(plain.reasoning, false);
  assert.equal(plain.thinkingLevelMap, undefined);
});

test("only verified models advertise grammar-constrained output", () => {
  assert.equal(GRAMMAR_OUTPUT_MODELS.has("sensenova-6.8-flash-lite"), false);
  assert.equal(GRAMMAR_OUTPUT_MODELS.has("glm-5.2"), true);

  const flagged = toPiModel({
    id: "glm-5.2",
    output_modalities: ["text"],
    context_length: 1000,
    max_output_length: 100,
    supported_features: ["reasoning"],
    pricing: {},
  });
  assert.equal(flagged.compat.supportsOpenAIGrammarTools, true);

  const unflagged = toPiModel({
    id: "sensenova-6.8-flash-lite",
    output_modalities: ["text"],
    context_length: 1000,
    max_output_length: 100,
    supported_features: ["reasoning"],
    pricing: {},
  });
  assert.equal(unflagged.compat.supportsOpenAIGrammarTools, false);
});

test("thinking level maps use values the gateway accepts", () => {
  // Live-verified reasoning.effort values on /v1/responses.
  const responsesAllowed = new Set(["none", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(sn.RESPONSES_THINKING_LEVELS.off, "none");
  for (const value of Object.values(sn.RESPONSES_THINKING_LEVELS)) {
    assert.ok(responsesAllowed.has(value), `unexpected reasoning.effort value: ${value}`);
  }

  // OpenAI-style reasoning_effort vocabulary on the completions path.
  const completionsAllowed = new Set(["low", "medium", "high"]);
  for (const [level, value] of Object.entries(sn.COMPLETIONS_THINKING_LEVELS)) {
    if (level === "off") continue;
    assert.ok(completionsAllowed.has(value), `unexpected reasoning_effort value: ${value}`);
  }

  // Every pi thinking level is mapped on both paths.
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  for (const level of levels) {
    assert.notEqual(sn.RESPONSES_THINKING_LEVELS[level], undefined, `responses map misses ${level}`);
    assert.notEqual(sn.COMPLETIONS_THINKING_LEVELS[level], undefined, `completions map misses ${level}`);
  }
});

test("pricing converts per-million strings and defaults missing values to 0", () => {
  assert.deepEqual(parseCost({ prompt: "0.10", completion: "0.30" }), {
    input: 0.1,
    output: 0.3,
    cacheRead: 0,
    cacheWrite: 0,
  });

  assert.deepEqual(parseCost({ input: 1, output: 2, input_cache_read: 0.5 }), {
    input: 1,
    output: 2,
    cacheRead: 0.5,
    cacheWrite: 0,
  });

  assert.deepEqual(parseCost(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(parseCost({ prompt: "free" }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("context and output limits fall back when metadata is missing", () => {
  const model = toPiModel({ id: "unknown-model", pricing: {} });
  assert.ok(model.contextWindow > 0);
  assert.ok(model.maxTokens > 0);
});

test("toPiModel ignores malformed records", () => {
  assert.equal(toPiModel(null), null);
  assert.equal(toPiModel({}), null);
  assert.equal(toPiModel({ id: "" }), null);
});

test("seed models expose both chat and image operations", () => {
  const byId = new Map(SEED_MODELS.map((model) => [model.id, model]));
  const flagship = byId.get("sensenova-6.8-flash-lite");

  assert.ok(flagship, "flagship model must be seeded");
  assert.equal(flagship.api, RESPONSES_API);
  assert.equal(flagship.reasoning, true);
  assert.ok(flagship.input.includes("image"), "flagship accepts image input");
  assert.equal(flagship.contextWindow, 262144);
  assert.equal(flagship.maxTokens, 65536);

  const painter = byId.get("sensenova-u1-fast");
  assert.ok(painter, "image generator must be seeded");
  assert.equal(painter.type, "image");
  assert.equal(painter.api, IMAGE_API);
});

test("prompt and reference extraction handles ImagesContext and transcripts", () => {
  assert.deepEqual(
    extractPromptAndReferences({
      input: [
        { type: "text", text: "a blue circle" },
        { type: "image", data: "AAAB", mimeType: "image/png" },
      ],
    }),
    {
      prompt: "a blue circle",
      references: [{ data: "AAAB", mimeType: "image/png" }],
    },
  );

  assert.deepEqual(
    extractPromptAndReferences({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello world" }] },
      ],
    }),
    { prompt: "hello world", references: [] },
  );

  assert.deepEqual(extractPromptAndReferences({ input: [] }), { prompt: "", references: [] });
});

test("image usage maps SenseNova counters into the pi cost model", () => {
  const model = { cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } };
  const usage = parseImageUsage({ input_tokens: 100, output_tokens: 50, total_tokens: 150 }, model);
  assert.deepEqual(
    { input: usage.input, output: usage.output, total: usage.totalTokens, cost: usage.cost },
    {
      input: 100,
      output: 50,
      total: 150,
      // Costs are USD per million tokens: $10/M x 100 tokens = $0.001.
      cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
    },
  );

  assert.equal(parseImageUsage(undefined, model), undefined);
});

test("extension entry point registers a provider and its commands", async () => {
  const calls = [];
  const fakePi = {
    registerProvider: (...args) => calls.push(["registerProvider", args]),
    registerCommand: (name, def) => calls.push(["registerCommand", name, def]),
    registerEntryRenderer: (...args) => calls.push(["registerEntryRenderer", args[0]]),
    appendEntry: (...args) => calls.push(["appendEntry", args]),
    on: (...args) => calls.push(["on", args[0]]),
  };

  const mod = await import("../extensions/sensenova.ts");
  mod.default(fakePi);

  const registration = calls.find((entry) => entry[0] === "registerProvider");
  assert.ok(registration, "provider must be registered");
  const provider = registration[1][0];
  assert.equal(provider.id, PROVIDER_ID);
  assert.equal(provider.name, "SenseNova");
  assert.equal(typeof provider.getModels, "function");
  assert.equal(typeof provider.refreshModels, "function");
  assert.equal(typeof provider.streamSimple, "function");
  assert.equal(typeof provider.generateImages, "function");
  assert.equal(typeof provider.auth?.apiKey?.resolve, "function");
  assert.equal(typeof provider.auth?.apiKey?.login, "function");

  assert.ok(provider.getModels().length >= 5, "seed models must be available before any network call");
  assert.ok(provider.getModels().every((model) => model.provider === PROVIDER_ID));
  assert.ok(provider.getAllModels().some((model) => model.type === "image"));

  const commands = calls.filter((entry) => entry[0] === "registerCommand").map((entry) => entry[1]);
  for (const expected of ["sensenova-models", "sensenova-refresh", "sensenova-usage"]) {
    assert.ok(commands.includes(expected), `missing /${expected}`);
  }

  // Commands must be safe in non-TUI modes where ctx.ui is absent.
  const modelsCommand = mod.default;
  assert.equal(typeof modelsCommand, "function");
});

test("auth resolves from the stored credential and falls back to the environment", async () => {
  const calls = [];
  const fakePi = {
    registerProvider: (...args) => calls.push(args),
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    appendEntry: () => {},
    on: () => {},
  };
  const mod = await import("../extensions/sensenova.ts");
  mod.default(fakePi);
  const provider = calls[0][0];

  const stored = await provider.auth.apiKey.resolve({
    ctx: { env: async () => "env-key" },
    credential: { type: "api_key", key: "stored-key" },
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(stored?.auth?.apiKey, "stored-key");
  assert.equal(stored?.source, "stored API key");

  const ambient = await provider.auth.apiKey.resolve({
    ctx: { env: async () => "env-key" },
    credential: undefined,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(ambient?.auth?.apiKey, "env-key");
  assert.equal(ambient?.source, "SENSENOVA_API_KEY");

  const none = await provider.auth.apiKey.resolve({
    ctx: { env: async () => undefined },
    credential: undefined,
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(none, undefined);
});

test("login rejects an empty key", async () => {
  const calls = [];
  const mod = await import("../extensions/sensenova.ts");
  mod.default({
    registerProvider: (...args) => calls.push(args),
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    appendEntry: () => {},
    on: () => {},
  });
  const provider = calls[0][0];

  await assert.rejects(
    provider.auth.apiKey.login({ prompt: async () => "   " }),
    /cannot be empty/,
  );

  const credential = await provider.auth.apiKey.login({ prompt: async () => "  sk-abc  " });
  assert.deepEqual(credential, { type: "api_key", key: "sk-abc" });
});

test("refreshModels serves the seed catalog when the network is disallowed", async () => {
  const calls = [];
  const mod = await import("../extensions/sensenova.ts");
  mod.default({
    registerProvider: (...args) => calls.push(args),
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    appendEntry: () => {},
    on: () => {},
  });
  const provider = calls[0][0];

  const published = [];
  await provider.refreshModels({
    credential: { type: "api_key", key: "sk-test" },
    stored: undefined,
    allowNetwork: false,
    signal: AbortSignal.timeout(60_000),
    publish: async (publication) => {
      published.push(publication);
      return true;
    },
  });

  // Offline refresh must never throw and must leave the seed catalog intact.
  assert.ok(provider.getModels().length >= 5);
  assert.equal(published.length, 0);
});

test("generateImages rejects a missing prompt without network access", async () => {
  const output = await sn.generateImages(
    {
      id: "sensenova-u1-fast",
      api: IMAGE_API,
      provider: PROVIDER_ID,
      baseUrl: `${BASE_URL}/images`,
      input: ["text", "image"],
      output: ["image", "text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { input: [] },
    { apiKey: "sk-test" },
  );
  assert.equal(output.stopReason, "error");
  assert.match(output.errorMessage ?? "", /text prompt/);
  assert.equal(output.output.length, 0);
});

test("generateImages posts b64_json to the generations endpoint and persists a copy", async () => {
  const { dir: tmpdir, restore } = await withTempCwd();
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAAAA", "base64").toString("base64");
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push({ url: String(url), body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ data: [{ b64_json: png }], output_format: "png", size: "1024x1024", usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }),
      };
    };

    const output = await sn.generateImages(
      {
        id: "sensenova-u1-fast",
        api: IMAGE_API,
        provider: PROVIDER_ID,
        baseUrl: `${BASE_URL}/images`,
        input: ["text", "image"],
        output: ["image", "text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      { input: [{ type: "text", text: "a blue circle" }] },
      { apiKey: "sk-test", fetch: fetchImpl },
    );

    assert.equal(output.stopReason, "stop", output.errorMessage);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${BASE_URL}/images/generations`);
    assert.equal(seen[0].body.response_format, "b64_json");
    assert.equal(seen[0].body.n, 1);
    assert.equal(seen[0].body.prompt, "a blue circle");

    const image = output.output.find((block) => block.type === "image");
    const text = output.output.find((block) => block.type === "text");
    assert.ok(image, "must return an image block");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data, png);
    assert.ok(text?.text.includes(".pi/generated-images"), "must report the saved path");
    assert.equal(output.usage?.totalTokens, 30);

    const { readdir } = await import("node:fs/promises");
    const saved = await readdir(`${tmpdir}/.pi/generated-images`);
    assert.equal(saved.length, 1);
    assert.ok(saved[0].endsWith(".png"));
  } finally {
    await restore();
  }
});

/**
 * Point process.cwd() at a fresh temp directory so generated images never
 * touch the repo. Returns the directory and a restore function.
 */
async function withTempCwd() {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const original = process.cwd();
  const created = await mkdtemp(join(os.tmpdir(), "pi-sensenova-provider-"));
  process.chdir(created);
  return {
    dir: created,
    restore: async () => {
      process.chdir(original);
      await rm(created, { recursive: true, force: true });
    },
  };
}

test("generateImages routes reference images to the edits endpoint", async () => {
  const { dir: tmpdir, restore } = await withTempCwd();
  try {
    const png = Buffer.from("iVBORw0KGgo", "base64").toString("base64");
    const seen = [];
    const output = await sn.generateImages(
      {
        id: "sensenova-u1.5-lite",
        api: IMAGE_API,
        provider: PROVIDER_ID,
        baseUrl: `${BASE_URL}/images`,
        input: ["text", "image"],
        output: ["image", "text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        input: [
          { type: "text", text: "make it a poster" },
          { type: "image", data: png, mimeType: "image/png" },
        ],
      },
      {
        apiKey: "sk-test",
        fetch: async (url, options) => {
          seen.push({ url: String(url), body: JSON.parse(options.body) });
          return {
            ok: true,
            status: 200,
            headers: new Map(),
            json: async () => ({ data: [{ b64_json: png }], output_format: "png", size: "1024x1024" }),
          };
        },
      },
    );
    assert.equal(output.stopReason, "stop", output.errorMessage);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${BASE_URL}/images/edits`);
    assert.equal(seen[0].body.prompt, "make it a poster");
    assert.equal(seen[0].body.images.length, 1);
    assert.match(seen[0].body.images[0].image_url, /^data:image\/png;base64,/);
    assert.ok(output.output.some((block) => block.type === "image"));
  } finally {
    await restore();
  }
});

test("generateImages surfaces upstream validation errors", async () => {
  const output = await sn.generateImages(
    {
      id: "sensenova-u1-fast",
      api: IMAGE_API,
      provider: PROVIDER_ID,
      baseUrl: `${BASE_URL}/images`,
      input: ["text"],
      output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { input: [{ type: "text", text: "a cat" }] },
    {
      apiKey: "sk-test",
      fetch: async () => ({
        ok: false,
        status: 400,
        headers: new Map(),
        json: async () => ({
          error: { message: "invalid images[0].image_url: image should be PNG, JPEG, or WebP", type: "invalid_request_error" },
        }),
      }),
    },
  );
  assert.equal(output.stopReason, "error");
  assert.match(output.errorMessage ?? "", /invalid images\[0\]\.image_url/);
});

test("generateImages does not reject when the API key is missing", async () => {
  const output = await sn.generateImages(
    {
      id: "sensenova-u1-fast",
      api: IMAGE_API,
      provider: PROVIDER_ID,
      baseUrl: `${BASE_URL}/images`,
      input: ["text"],
      output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    { input: [{ type: "text", text: "a cat" }] },
    undefined,
  );
  assert.equal(output.stopReason, "error");
  assert.match(output.errorMessage ?? "", /API key/);
});

test("the extension source is syntactically loadable", () => {
  const source = readFileSync(new URL("../extensions/sensenova.ts", import.meta.url), "utf8");
  assert.ok(source.includes("createProvider"), "must use the native Provider form");
  assert.ok(source.includes(RESPONSES_API), "must register the Responses API");
  assert.ok(source.includes("openai-responses.lazy"), "must load the responses adapter");
  assert.ok(source.includes("openai-completions.lazy"), "must load the completions adapter");
});

// ---------------------------------------------------------------------------
// Client-side rate limiting
// ---------------------------------------------------------------------------

const { RATE_LIMIT, RateLimiter, rateLimiter, ModelBucket, makeRateLimitedFetch, withRateLimit, isQuotaExhausted, describeHttpError, errorResponse, parseRetryAfterMs, RETRYABLE_STATUS, sleep } = sn;

async function withConfig(overrides, fn) {
  const keys = Object.keys(RATE_LIMIT);
  const saved = Object.fromEntries(keys.map((key) => [key, RATE_LIMIT[key]]));
  Object.assign(RATE_LIMIT, overrides);
  try {
    await fn();
  } finally {
    // Restoring synchronously here would undo the overrides while an async body
    // is still running, so the whole body is awaited first.
    Object.assign(RATE_LIMIT, saved);
  }
}

test("bucket starts with a burst of tokens, then paces by rpm", async () => {
  await withConfig({ rpm: 600, burst: 2 }, async () => {
    const bucket = rateLimiter.bucket("m");
    const now = Date.now();

    // The whole burst is immediately spendable.
    assert.equal(bucket.waitMs(now), 0, "burst should be available up front");
    bucket.take(now);
    assert.equal(bucket.requests, 1);
    assert.equal(bucket.waitMs(now), 0, "second burst token should also be immediate");
    bucket.take(now);
    assert.equal(bucket.requests, 2);

    // The third request must wait for the refill.
    assert.ok(bucket.waitMs(now) > 0, "third request should be paced");
    assert.ok(bucket.waitMs(now) < 200, "wait should be about one refill interval");

    // After the refill exactly one token is back, so the next one is paced again.
    assert.equal(bucket.waitMs(now + 150), 0, "one token should be refilled after one interval");
    bucket.take(now + 150);
    assert.ok(bucket.waitMs(now + 150) > 0, "consuming it re-opens the pacing");
  });
});

test("cooldown blocks the bucket and escalates on consecutive throttles", async () => {
  await withConfig({ cooldownBaseMs: 100, cooldownMaxMs: 4000, rpm: 600, burst: 1 }, async () => {
    const bucket = rateLimiter.bucket("m");
    const now = Date.now();

    assert.equal(bucket.cooldownUntil, 0, "no cooldown initially");

    let first = rateLimiter.onRateLimited("m", null);
    assert.ok(first >= 100, `first cooldown should be at least the base (${first})`);
    assert.equal(bucket.consecutiveThrottles, 1);
    assert.ok(bucket.waitMs(now) > 0, "bucket should be parked during the cooldown");

    let second = rateLimiter.onRateLimited("m", null);
    assert.ok(second > first, `second cooldown should escalate (${second} > ${first})`);

    for (let i = 3; i <= 8; i += 1) {
      second = rateLimiter.onRateLimited("m", null);
      assert.ok(second <= 4000, `cooldown must respect the cap (${second})`);
    }
    assert.ok(rateLimiter.onRateLimited("m", null) <= 4000, "cooldown must saturate at the cap");

    // A success resets the escalation ladder.
    rateLimiter.onSucceeded("m");
    assert.equal(bucket.consecutiveThrottles, 0);

    rateLimiter.reset("m");
  });
});

test("retry-after is honored and takes precedence over the local escalation", async () => {
  await withConfig({ cooldownBaseMs: 1000, cooldownMaxMs: 600_000 }, async () => {
    const headers = new Headers({ "retry-after": "7" });
    const cooldown = rateLimiter.onRateLimited("retry-after-model", headers);
    assert.equal(Math.floor(cooldown / 1000), 7, "retry-after seconds should win");
    rateLimiter.reset("retry-after-model");
  });
});

test("parseRetryAfterMs handles seconds, http dates and garbage", () => {
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "9" })), 9000);
  assert.equal(parseRetryAfterMs(new Headers()), undefined);
  assert.equal(parseRetryAfterMs({ "retry-after": "3.5" }), undefined);
  const future = new Date(Date.now() + 60_000).toUTCString();
  const fromDate = parseRetryAfterMs(new Headers({ "retry-after": future }));
  assert.ok(fromDate > 55_000 && fromDate <= 60_000, `http date should parse to ms (${fromDate})`);
  assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "not a date" })), undefined);
  assert.equal(parseRetryAfterMs(undefined), undefined);
});

test("quota exhaustion is classified separately from a rate limit", () => {
  assert.ok(isQuotaExhausted(429, "free quota exhausted"), "free quota exhausted");
  assert.ok(isQuotaExhausted(429, "FREE_QUOTA_EXHAUSTED"), "snake case code");
  assert.ok(isQuotaExhausted(429, "token plan limit exhausted"), "token plan limit");
  assert.ok(isQuotaExhausted(403, "model is not available in the current token plan"), "token plan 403");

  assert.ok(!isQuotaExhausted(429, "inference exceeds tpm/rpm limit"), "tpm/rpm is transient");
  assert.ok(!isQuotaExhausted(429, "rps exhausted"), "rps is transient");
  assert.ok(!isQuotaExhausted(429, "RateLimitExceeded.EndpointRPMExceeded"), "endpoint rpm is transient");
  assert.ok(!isQuotaExhausted(429, "{}"), "empty body is not quota");
  assert.ok(!isQuotaExhausted(403, "risk control blocked"), "403 risk block is not quota");
});

test("describeHttpError distinguishes quota, rate limit and other failures", async () => {
  const quota = describeHttpError(429, "quota exhausted: window resets in 4h");
  assert.match(quota, /quota exhausted/i);
  assert.match(quota, /Waiting does not recover/i);
  assert.match(quota, /Check the Token Plan console/i);

  const rate = describeHttpError(429, "inference exceeds tpm/rpm limit");
  assert.match(rate, /rate limited/);
  assert.match(rate, /tpm\/rpm limit/);
  assert.doesNotMatch(rate, /quota exhausted/i);

  assert.equal(describeHttpError(403, "x"), "x");
  assert.equal(describeHttpError(500, ""), "unknown error");

  // The reconstructed body must stay valid JSON whether or not the upstream
  // body was already an object.
  const json = JSON.parse((await errorResponse(429, '{"error":"x"}', "boom").text()));
  assert.equal(json.error.message, "boom");
  const text = JSON.parse((await errorResponse(503, "gateway trouble", "boom").text()));
  assert.equal(text.error.message, "boom");
});

test("429 and 5xx are retryable, 4xx are not", () => {
  for (const status of [408, 429, 500, 502, 503, 504, 529]) {
    assert.ok(RETRYABLE_STATUS.has(status), `${status} should be retryable`);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.ok(!RETRYABLE_STATUS.has(status), `${status} must not be retried`);
  }
});

test("acquire paces callers, honours abort and gives up after maxWait", async () => {
  const limiter = new RateLimiter({
    enabled: true,
    rpm: 600, // one token per 100ms
    burst: 1,
    maxWaitMs: 500,
    cooldownBaseMs: 100,
    cooldownMaxMs: 1000,
    retries: 0,
    backoffBaseMs: 50,
    backoffMaxMs: 100,
  });

  const bucket = limiter.bucket("paced");

  // The burst token is immediate.
  const t0 = Date.now();
  await limiter.acquire("paced", undefined);
  assert.ok(Date.now() - t0 < 20, "burst token should be granted immediately");

  // The next request waits for the refill.
  const t1 = Date.now();
  await limiter.acquire("paced", undefined);
  const waited = Date.now() - t1;
  assert.ok(waited >= 85, `should wait for the refill (${waited}ms)`);
  assert.ok(bucket.totalWaitedMs >= 85, "waiting should be accounted for");

  // An already-aborted signal returns without waiting.
  const aborting = new AbortController();
  aborting.abort();
  const t2 = Date.now();
  await limiter.acquire("aborted", aborting.signal);
  assert.ok(Date.now() - t2 < 20, "aborted acquire must not wait");
  assert.equal(limiter.bucket("aborted").requests, 0, "aborted acquire must not consume a token");

  // Exceeding maxWaitMs proceeds anyway so the gateway can answer with a real
  // 429 rather than hanging indefinitely.
  const impatient = new RateLimiter({
    enabled: true, rpm: 600, burst: 1, maxWaitMs: 30, cooldownBaseMs: 100,
    cooldownMaxMs: 1000, retries: 0, backoffBaseMs: 50, backoffMaxMs: 100,
  });
  const target = impatient.bucket("over-budget");
  target.take(Date.now()); // spend the burst token so a refill is outstanding
  const t3 = Date.now();
  await impatient.acquire("over-budget", undefined);
  const over = Date.now() - t3;
  assert.ok(over >= 25 && over < 200, `should give up after maxWait (${over}ms)`);
  assert.equal(impatient.bucket("over-budget").requests, 2, "the manual take plus the proceed after maxWait");
});

test("fetch wrapper retries a 429, then reports success", async () => {
  await withConfig(
    { rpm: 600, burst: 5, retries: 3, backoffBaseMs: 1, backoffMaxMs: 5, cooldownBaseMs: 2, cooldownMaxMs: 20, maxWaitMs: 5000 },
    async () => {
      let calls = 0;
      const inner = async (input, init) => {
        calls += 1;
        if (calls < 3) return new Response("{\"error\":\"inference exceeds tpm/rpm limit\"}", { status: 429 });
        return new Response("{\"ok\":true}", { status: 200 });
      };
      const fetchFn = makeRateLimitedFetch("retried-model", inner);
      const response = await fetchFn("https://example.test/v1/chat/completions", { method: "POST", body: "{}" });
      assert.equal(response.status, 200);
      assert.equal(calls, 3, "two retries then success");

      const bucket = rateLimiter.bucket("retried-model");
      assert.equal(bucket.rateLimited, 2, "both 429s recorded");
      assert.equal(bucket.retries, 2, "both retries recorded");
      rateLimiter.reset("retried-model");
    },
  );
});

test("fetch wrapper gives up on a 429 after the retry budget is spent", async () => {
  await withConfig(
    { rpm: 600, burst: 5, retries: 2, backoffBaseMs: 1, backoffMaxMs: 3, cooldownBaseMs: 2, cooldownMaxMs: 10, maxWaitMs: 5000 },
    async () => {
      let calls = 0;
      const inner = async () => {
        calls += 1;
        return new Response("{\"message\":\"rps exhausted\"}", { status: 429 });
      };
      const fetchFn = makeRateLimitedFetch("gave-up-model", inner);
      const response = await fetchFn("https://example.test/v1/chat/completions", { method: "POST" });
      // The status and the upstream detail are preserved so pi-ai can format a
      // real provider error instead of a bare "Connection error."
      assert.equal(response.status, 429);
      const payload = await response.json();
      assert.match(payload.error.message, /rate limited/i);
      assert.match(payload.error.message, /rps exhausted/);
      assert.match(payload.error.message, /throttled/);
      assert.equal(calls, 3, "initial attempt plus two retries");
      rateLimiter.reset("gave-up-model");
    },
  );
});

test("fetch wrapper never retries quota exhaustion and parks the model", async () => {
  await withConfig(
    { rpm: 600, burst: 5, retries: 5, backoffBaseMs: 1, backoffMaxMs: 3, cooldownBaseMs: 2, cooldownMaxMs: 10, maxWaitMs: 5000 },
    async () => {
      let calls = 0;
      const inner = async () => {
        calls += 1;
        return new Response("{\"error\":\"FREE_QUOTA_EXHAUSTED\"}", { status: 429 });
      };
      const fetchFn = makeRateLimitedFetch("quota-model", inner);
      const response = await fetchFn("https://example.test/v1/chat/completions", { method: "POST" });
      assert.equal(response.status, 429);
      const payload = await response.json();
      assert.match(payload.error.message, /quota exhausted/i);
      assert.match(payload.error.message, /Waiting does not recover/i);
      assert.equal(calls, 1, "quota exhaustion must not be retried");

      const bucket = rateLimiter.bucket("quota-model");
      const remaining = bucket.cooldownUntil - Date.now();
      // Tolerate the milliseconds that elapse between setting and reading.
      assert.ok(remaining >= 10 * 60_000 - 100, `model should be parked for a long time (${remaining}ms)`);
      rateLimiter.reset("quota-model");
    },
  );
});

test("fetch wrapper waits out the retry-after hint", async () => {
  await withConfig(
    { rpm: 600, burst: 5, retries: 1, backoffBaseMs: 1, backoffMaxMs: 3, cooldownBaseMs: 1, cooldownMaxMs: 60_000, maxWaitMs: 5000 },
    async () => {
      let calls = 0;
      const inner = async () => {
        calls += 1;
        return calls === 1
          ? new Response("{}", { status: 429, headers: { "retry-after": "1" } })
          : new Response("{}", { status: 200 });
      };
      const fetchFn = makeRateLimitedFetch("retry-after-model-2", inner);
      const start = Date.now();
      await fetchFn("https://example.test/v1/chat/completions", { method: "POST" });
      assert.ok(Date.now() - start >= 900, "should wait for the retry-after hint");
      rateLimiter.reset("retry-after-model-2");
    },
  );
});

test("fetch wrapper passes through non-retryable errors untouched", async () => {
  await withConfig({ rpm: 600, burst: 5, retries: 5, maxWaitMs: 5000, cooldownBaseMs: 100, cooldownMaxMs: 200 }, async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return new Response("{\"error\":{\"message\":\"invalid params\"}}", { status: 400 });
    };
    const response = await makeRateLimitedFetch("passthrough-model", inner)("https://example.test/x", { method: "POST" });
    assert.equal(response.status, 400);
    assert.equal(calls, 1);
    rateLimiter.reset("passthrough-model");
  });
});

test("withRateLimit injects a paced fetch into both stream entry points", async () => {
  const seen = [];
  const inner = {
    stream: (model, _context, options) => {
      seen.push(["stream", model.id, typeof options?.fetch]);
      return { stream: true };
    },
    streamSimple: (model, _context, options) => {
      seen.push(["streamSimple", model.id, typeof options?.fetch]);
      return { stream: true };
    },
  };

  const wrapped = withRateLimit(inner);
  const model = { id: "injected-model" };
  wrapped.stream(model, {}, {});
  wrapped.streamSimple(model, {}, { apiKey: "k" });

  assert.deepEqual(seen, [
    ["stream", "injected-model", "function"],
    ["streamSimple", "injected-model", "function"],
  ]);

  // Caller-supplied fetch must be preserved as the inner transport.
  let markerCalls = 0;
  const marker = async () => {
    markerCalls += 1;
    return new Response("{}", { status: 200 });
  };
  const withCaller = withRateLimit({ stream: (_m, _c, options) => (options?.fetch ?? null) });
  const injected = withCaller.stream(model, {}, { fetch: marker });
  assert.equal(typeof injected, "function", "a paced fetch must be injected");
  await injected("https://example.test/v1/chat/completions", { method: "POST" });
  assert.equal(markerCalls, 1, "the injected fetch must delegate to the caller fetch");

  assert.equal(withRateLimit(undefined), undefined, "missing streams must pass through");

  // Absent entry points stay absent.
  const partial = withRateLimit({ stream: inner.stream });
  assert.equal(typeof partial.stream, "function", "stream must be wrapped");
  assert.equal("streamSimple" in partial, false, "absent streamSimple must stay absent");

  // The limiter can be switched off at runtime, reverting to the plain streams.
  await withConfig({ enabled: false }, async () => {
    assert.equal(withRateLimit(inner), inner, "disabled limiter must return the streams untouched");
  });
});

test("disabled limiter passes fetch straight through", async () => {
  await withConfig({ enabled: false }, async () => {
    const marker = async () => new Response("{}", { status: 200 });
    assert.equal(makeRateLimitedFetch("any-model", marker), marker, "disabled limiter must return the caller fetch");

    const inner = { stream: () => ({}) };
    assert.equal(withRateLimit(inner), inner, "disabled limiter must return the streams untouched");

    const start = Date.now();
    await rateLimiter.acquire("no-wait", undefined);
    assert.ok(Date.now() - start < 50, "disabled limiter must not wait");
  });
});

test("rate limit defaults are sane for the token plan", () => {
  assert.ok(RATE_LIMIT.enabled, "rate limiting should be on by default");
  assert.ok(RATE_LIMIT.rpm >= 1 && RATE_LIMIT.rpm <= 120, `rpm default should stay small (${RATE_LIMIT.rpm})`);
  assert.ok(RATE_LIMIT.burst >= 1, "burst must be at least one");
  assert.ok(RATE_LIMIT.backoffBaseMs < RATE_LIMIT.backoffMaxMs, "backoff must escalate");
  assert.ok(RATE_LIMIT.cooldownBaseMs < RATE_LIMIT.cooldownMaxMs, "cooldown must escalate");
  assert.ok(RATE_LIMIT.cooldownBaseMs > RATE_LIMIT.backoffBaseMs, "cooldown should outlast one backoff step");
  assert.ok(RATE_LIMIT.maxWaitMs > RATE_LIMIT.cooldownMaxMs, "maxWait should outlast a cooldown");
});

test("throttle command is registered and reports bucket state", async () => {
  const mod = await import("../extensions/sensenova.ts");
  const calls = [];
  mod.default({
    registerProvider: () => {},
    registerCommand: (name, def) => calls.push([name, def]),
    registerEntryRenderer: () => {},
    appendEntry: () => {},
    on: () => {},
  });

  const names = calls.map((entry) => entry[0]);
  assert.ok(names.includes("sensenova-throttle"), `missing /sensenova-throttle (got ${names.join(", ")})`);

  const [, definition] = calls.find((entry) => entry[0] === "sensenova-throttle");
  let markdown;
  const fakeCtx = { hasUI: false, mode: "cli" };
  const originalLog = console.log;
  console.log = (text) => { markdown = text; };
  try {
    await definition.handler("", fakeCtx);
    assert.match(markdown, /Requests \/ minute per model/);
    assert.match(markdown, /SENSENOVA_RPM/);

    await definition.handler("reset", fakeCtx);
    assert.match(markdown, /Cooldowns cleared/);
  } finally {
    console.log = originalLog;
    rateLimiter.reset();
  }
});

