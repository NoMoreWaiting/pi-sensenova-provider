// Live smoke test: drives the provider through pi-ai's normalizeContext() and
// the real gateways. Run with: node scripts/smoke-live.mjs
//
// Requires SENSENOVA_API_KEY. Skipped automatically when it is missing.
//
// Rate-limit failures are reported as warnings rather than hard failures: the
// gateway validates the request shape before enforcing RPM/TPM quotas, so a
// 429 still proves the payload is well formed.

import { strict as assert } from "node:assert";
import { normalizeContext } from "@earendil-works/pi-ai";

import extension, { __testing as sn } from "../extensions/sensenova.ts";

const apiKey = process.env.SENSENOVA_API_KEY;
if (!apiKey) {
  console.log("SKIP: SENSENOVA_API_KEY is not set");
  process.exit(0);
}

const { BASE_URL, toPiModel } = sn;
const provider = buildProvider();
let checks = 0;
let failures = 0;

function check(condition, label, detail) {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` — ${detail}`}`);
  return condition;
}

// ---------------------------------------------------------------------------
// 1. Live catalog discovery.
// ---------------------------------------------------------------------------
console.log("\n=== GET /v1/models ===");
await provider.refreshModels({
  credential: { type: "api_key", key: apiKey },
  stored: undefined,
  allowNetwork: true,
  signal: AbortSignal.timeout(60_000),
  publish: async () => true,
});
const catalog = provider.getAllModels();
for (const model of catalog) {
  console.log(
    `  ${model.id.padEnd(24)} ${String(model.type).padEnd(7)} ${model.api.padEnd(18)} ` +
      `ctx=${String(model.contextWindow ?? "-").padEnd(8)} out=${String(model.maxTokens ?? "-").padEnd(8)} reasoning=${String(model.reasoning ?? "-")}`,
  );
}
check(catalog.length > 0, "catalog is non-empty", `${catalog.length} models`);

// ---------------------------------------------------------------------------
// 2. Chat through the OpenAI Responses endpoint (pi's built-in adapter).
// ---------------------------------------------------------------------------
console.log("\n=== streamSimple: sensenova-6.8-flash-lite via /v1/responses ===");
const flagship = catalog.find((model) => model.id === "sensenova-6.8-flash-lite");
check(!!flagship, "flagship model present");
const turn = await streamTurn(
  flagship,
  apiKey,
  "Answer in one short sentence: what do you help with?",
  undefined,
  "low",
  true,
);
check(turn.api === "openai-responses", "routed through the Responses API", turn.api);
check(turn.textChars > 0, "answer text streamed", `${turn.textChars} chars`);
check(turn.thinkingChars > 0, "reasoning streamed", `${turn.thinkingChars} chars`);
check(turn.usage.totalTokens > 0, "usage reported", JSON.stringify(turn.usage));

// ---------------------------------------------------------------------------
// 3. Tool calling through the Responses API.
// ---------------------------------------------------------------------------
console.log("\n=== tool calling: glm-5.2 ===");
const glm = catalog.find((model) => model.id === "glm-5.2");
if (glm) {
  const toolTurn = await streamTurn(glm, apiKey, "What is 17 times 6? Use the multiply tool.", [
    {
      name: "multiply",
      description: "Multiply two integers.",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
    },
  ]);
  if (!toolTurn.rateLimited) {
    check(toolTurn.stopReason === "toolUse", "stop reason is toolUse", toolTurn.stopReason);
    check(toolTurn.toolCalls.length > 0, "tool call emitted", `${toolTurn.toolCalls.length} calls`);
  }
}

// ---------------------------------------------------------------------------
// 4. Thinking off vs on.
// ---------------------------------------------------------------------------
console.log("\n=== reasoning off vs low ===");
const offTurn = await streamTurn(flagship, apiKey, "Say hi in one word.", undefined, "off");
const lowTurn = await streamTurn(flagship, apiKey, "Say hi in one word.", undefined, "low");
check(
  !offTurn.rateLimited && offTurn.reasoningTokens === 0,
  "effort none produces no reasoning tokens",
  `reasoning=${offTurn.reasoningTokens}`,
);
check(lowTurn.reasoningTokens > 0, "effort low produces reasoning tokens", `reasoning=${lowTurn.reasoningTokens}`);

// ---------------------------------------------------------------------------
// 5. Chat Completions fallback branch (non-Responses models).
// ---------------------------------------------------------------------------
console.log("\n=== streamSimple: deepseek-v4-pro via /v1/chat/completions ===");
const fallback = toPiModel({
  id: "deepseek-v4-pro",
  input_modalities: ["text"],
  output_modalities: ["text"],
  context_length: 1048576,
  max_output_length: 65536,
  supported_features: ["tools", "json_mode", "reasoning"],
  pricing: {},
});
check(fallback.api === sn.COMPLETIONS_API, "non-Responses model uses chat completions", fallback.api);
const completionsTurn = await streamTurn(
  fallback,
  apiKey,
  "Answer in one word: what is 2+2?",
  undefined,
  "low",
  true,
);
check(completionsTurn.api === sn.COMPLETIONS_API, "routed through chat completions", completionsTurn.api);

// ---------------------------------------------------------------------------
// 6. Vision input.
// ---------------------------------------------------------------------------
console.log("\n=== vision input: sensenova-6.8-flash-lite ===");
const png1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const visionStream = provider.streamSimple(
  flagship,
  normalizeContext({
    messages: [
      {
        role: "user",
        content: [
          { type: "image", data: png1x1, mimeType: "image/png" },
          { type: "text", text: "You just saw an image. Reply with exactly one word." },
        ],
        timestamp: Date.now(),
      },
    ],
  }),
  { apiKey, reasoning: "off", maxTokens: 1000, signal: AbortSignal.timeout(180_000) },
);
let visionChars = 0;
for await (const event of visionStream) {
  if (event.type === "text_delta") visionChars += event.delta.length;
}
const visionMessage = await visionStream.result();
check(
  visionMessage.stopReason !== "error",
  "vision request accepted",
  visionMessage.errorMessage ?? visionMessage.stopReason,
);
check(visionChars > 0, "vision reply produced text", `${visionChars} chars`);

// ---------------------------------------------------------------------------
// 7. Image generation.
// ---------------------------------------------------------------------------
console.log("\n=== generateImages: sensenova-u1-fast ===");
const painter = catalog.find((model) => model.id === "sensenova-u1-fast");
if (painter) {
  const output = await provider.generateImages(
    painter,
    { input: [{ type: "text", text: "a tiny red dot on a white background, flat vector style" }] },
    { apiKey, signal: AbortSignal.timeout(240_000) },
  );
  check(output.stopReason === "stop", "image generation succeeded", output.errorMessage);
  const image = output.output.find((block) => block.type === "image");
  check(!!image && image.data.length > 1000, "image block returned", image ? `${image.data.length} b64 chars` : "none");
  check(image?.mimeType === "image/png", "png mime type", image?.mimeType);
  console.log(`  ${output.output.find((block) => block.type === "text")?.text}`);
}

console.log(`\nSMOKE DONE — ${checks} checks, ${failures} failed`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildProvider() {
  const created = [];
  extension({
    registerProvider: (...args) => created.push(args[0]),
    registerCommand: () => {},
    registerEntryRenderer: () => {},
    appendEntry: () => {},
    on: () => {},
  });
  assert.equal(created.length, 1, "exactly one provider registered");
  return created[0];
}

async function streamTurn(model, apiKey, prompt, tools, reasoning = "low", verbose = false) {
  const context = normalizeContext({
    systemPrompt: "You are a concise assistant.",
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    ...(tools ? { tools } : {}),
  });

  const stream = provider.streamSimple(model, context, {
    apiKey,
    reasoning,
    maxTokens: 2000,
    signal: AbortSignal.timeout(180_000),
    onPayload: verbose
      ? (payload) => {
          console.log(`    payload: ${JSON.stringify(payload).slice(0, 900)}`);
        }
      : undefined,
  });

  const toolCalls = [];
  let thinkingChars = 0;
  let textChars = 0;
  for await (const event of stream) {
    if (event.type === "thinking_delta") thinkingChars += event.delta.length;
    else if (event.type === "text_delta") textChars += event.delta.length;
    else if (event.type === "toolcall_end") {
      toolCalls.push(event.toolCall);
      console.log(`    tool_call ${event.toolCall.name}(${JSON.stringify(event.toolCall.arguments)})`);
    }
  }

  const message = await stream.result();
  const rateLimited = /rps exhausted|tpm\/rpm limit|RateLimitExceeded/i.test(message.errorMessage ?? "");

  const result = {
    message,
    api: message.api,
    stopReason: message.stopReason,
    textChars,
    thinkingChars,
    toolCalls,
    usage: message.usage,
    reasoningTokens: message.usage?.reasoning ?? 0,
    rateLimited,
  };

  if (message.stopReason === "error") {
    if (!rateLimited) throw new Error(`${model.id}: ${message.errorMessage}`);
    console.log(`    RATE LIMITED (payload accepted): ${(message.errorMessage ?? "").slice(0, 90)}`);
    return result;
  }

  console.log(
    `    stop=${message.stopReason} thinkingChars=${thinkingChars} textChars=${textChars} ` +
      `toolCalls=${toolCalls.length} tokens=${message.usage.totalTokens} ` +
      `(reasoning=${message.usage.reasoning ?? 0}) cost=$${message.usage.cost.total.toFixed(6)}`,
  );
  if (!tools) {
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    console.log(`    reply: ${text.trim().slice(0, 120)}`);
  }
  return result;
}
