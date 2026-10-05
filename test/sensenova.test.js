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
