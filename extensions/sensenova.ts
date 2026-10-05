// SenseNova Token Plan provider for Pi
// https://platform.sensenova.cn/docs
//
// Endpoints verified against the live gateway (token.sensenova.cn):
//   POST /v1/responses           OpenAI Responses API, stateless (store=false only)
//   POST /v1/chat/completions    OpenAI Chat Completions
//   GET  /v1/models              OpenRouter-style rich model metadata
//   POST /v1/images/generations  image generation (b64_json or url)
//   POST /v1/images/edits        image editing (256-4096px, aspect ratio <= 2:1)
//
// Chat streaming is delegated to pi-ai's built-in `openai-responses` and
// `openai-completions` implementations, so message conversion, tool calling,
// reasoning streaming, usage accounting, cancellation and retries stay in sync
// with Pi instead of being reimplemented here.
//
// Auth: SENSENOVA_API_KEY env var, or `pi /login sensenova`.

import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createProvider } from "@earendil-works/pi-ai";

// pi-ai exposes the API implementations through subpath exports. Load the
// lazy wrappers (they return ProviderStreams and defer the real module load
// until the first stream call), falling back to the deprecated compat barrel
// so the extension keeps working across pi-ai layouts.
async function loadApi(subpath, exportName) {
  try {
    const mod = await import(`@earendil-works/pi-ai/api/${subpath}`);
    if (typeof mod[exportName] === "function") return mod[exportName];
  } catch {
    // Fall through to the compat barrel.
  }
  try {
    const compat = await import("@earendil-works/pi-ai/compat");
    if (typeof compat[exportName] === "function") return compat[exportName];
  } catch {
    // Fall through.
  }
  return undefined;
}

const openAIResponsesApi =
  (await loadApi("openai-responses.lazy", "openAIResponsesApi")) ?? (() => {
    throw new Error("pi-ai does not export openAIResponsesApi");
  });
const openAICompletionsApi =
  (await loadApi("openai-completions.lazy", "openAICompletionsApi")) ?? (() => {
    throw new Error("pi-ai does not export openAICompletionsApi");
  });

// The TUI package is provided by pi at runtime. Keep it optional so print/RPC
// usage and lightweight provider tests do not fail when it is missing.
let Image;
let Markdown;
try {
  ({ Image, Markdown } = await import("@earendil-works/pi-tui"));
} catch {
  Image = undefined;
  Markdown = undefined;
}

let getMarkdownTheme;
try {
  getMarkdownTheme = (await import("@earendil-works/pi-coding-agent")).getMarkdownTheme;
} catch {
  getMarkdownTheme = undefined;
}

// ---------------------------------------------------------------------------
// Provider identity and endpoint routing
// ---------------------------------------------------------------------------

const PROVIDER_ID = "sensenova";
const API_KEY_ENV = "SENSENOVA_API_KEY";
const BASE_URL = "https://token.sensenova.cn/v1";
const RESPONSES_API = "openai-responses";
const COMPLETIONS_API = "openai-completions";
const IMAGE_API = "sensenova-images";

/**
 * Models the platform serves on the OpenAI Responses endpoint. Source:
 * SenseNova Token Plan announcement (2026-09-29). Models outside this set fall
 * back to /v1/chat/completions, which the gateway still supports.
 */
const RESPONSES_MODELS = new Set([
  "sensenova-6.8-flash-lite",
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "glm-5.2",
  "kimi-k3",
]);

/**
 * Models that accept OpenAI `text.format` grammar-constrained output. Verified
 * live: deepseek-v4-flash, glm-5.2 and kimi-k3 return valid constrained JSON
 * while sensenova-6.8-flash-lite fails with `compile_grammar_error` in the
 * upstream tokenizer. Leave false for models that were not verified.
 */
const GRAMMAR_OUTPUT_MODELS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "glm-5.2",
  "kimi-k3",
]);

/**
 * pi thinking levels -> `reasoning.effort` accepted by /v1/responses.
 * Verified values: none, low, medium, high, xhigh. `none` yields zero
 * reasoning tokens; `summary: "none"` is rejected, so pi's default `summary:
 * "auto"` is the only safe summary value.
 */
const RESPONSES_THINKING_LEVELS = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/**
 * pi thinking levels -> `reasoning_effort` for the /v1/chat/completions path,
 * which uses the DeepSeek `thinking: { type }` shape instead.
 */
const COMPLETIONS_THINKING_LEVELS = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 32768;

// ---------------------------------------------------------------------------
// Small coercion helpers
// ---------------------------------------------------------------------------

function stringArray(value, fallback) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : fallback;
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * SenseNova returns OpenRouter-shaped pricing (`prompt`, `completion`,
 * `input_cache_read`, `input_cache_write`) denominated per million tokens,
 * which is the unit pi's cost model uses. Values are strings and may be "0"
 * during the token-plan preview.
 */
function parseCost(pricing) {
  const p = pricing && typeof pricing === "object" ? pricing : {};
  return {
    input: money(p.prompt ?? p.input),
    output: money(p.completion ?? p.output),
    cacheRead: money(p.input_cache_read ?? p.cache_read),
    cacheWrite: money(p.input_cache_write ?? p.cache_write),
  };
}

// ---------------------------------------------------------------------------
// Catalog conversion
// ---------------------------------------------------------------------------

/**
 * Convert one raw SenseNova model record (the shape returned by GET /v1/models,
 * also used verbatim for the offline seed catalog) into a pi model entry.
 * Image-output models become image models; everything else is a chat model.
 */
function toPiModel(raw) {
  const id = typeof raw?.id === "string" ? raw.id : "";
  if (!id) return null;

  const inputModalities = stringArray(raw.input_modalities, ["text"]);
  const outputModalities = stringArray(raw.output_modalities, ["text"]);
  const features = new Set(stringArray(raw.supported_features, []));
  const outputImage = outputModalities.includes("image");

  const meta = {
    features: [...features],
    sampling: stringArray(raw.supported_sampling_parameters, []),
    description: typeof raw.description === "string" ? raw.description : "",
    priceImage: money(raw.pricing?.image),
    priceRequest: money(raw.pricing?.request),
    businesses: stringArray(raw.businesses, []),
  };

  const base = {
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : id,
    api: outputImage ? IMAGE_API : RESPONSES_MODELS.has(id) ? RESPONSES_API : COMPLETIONS_API,
    provider: PROVIDER_ID,
    // OpenAI SDK clients append the endpoint segment (`/responses`,
    // `/chat/completions`) to baseUrl, so this stays at the version root.
    baseUrl: outputImage ? `${BASE_URL}/images` : BASE_URL,
    cost: parseCost(raw.pricing),
    sensenova: meta,
  };

  if (outputImage) {
    // /v1/images/edits accepts reference images, so the model takes both.
    return {
      ...base,
      type: "image",
      input: ["text", "image"],
      output: ["image", "text"],
    };
  }

  const reasoning =
    features.has("reasoning") ||
    /^(deepseek|glm-|kimi)/.test(id);

  return {
    ...base,
    type: "chat",
    input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
    reasoning,
    contextWindow: toInt(raw.context_length, DEFAULT_CONTEXT_WINDOW),
    maxTokens: toInt(raw.max_output_length, DEFAULT_MAX_TOKENS),
    ...(reasoning
      ? { thinkingLevelMap: base.api === RESPONSES_API ? RESPONSES_THINKING_LEVELS : COMPLETIONS_THINKING_LEVELS }
      : {}),
    compat:
      base.api === RESPONSES_API
        ? {
            supportsDeveloperRole: true,
            supportsMaxOutputTokens: true,
            supportsStrictMode: true,
            supportsOpenAIGrammarTools: GRAMMAR_OUTPUT_MODELS.has(id),
          }
        : {
            thinkingFormat: "deepseek",
            supportsReasoningEffort: true,
            // The completions gateway rejects the `developer` role; pi folds it
            // into `system` instead.
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens",
          },
  };
}

// ---------------------------------------------------------------------------
// Seed catalog
// ---------------------------------------------------------------------------

/**
 * Offline baseline, snapshotted from GET /v1/models. Shape mirrors the API
 * response so the seed and the live catalog flow through the same converter.
 * Kept intentionally small and flagship-focused; new or renamed upstream models
 * arrive through the background refresh instead.
 */
const SEED_CATALOG = [
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash Lite",
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    context_length: 262144,
    max_output_length: 65536,
    supported_features: ["tools", "json_mode", "reasoning"],
    supported_sampling_parameters: ["temperature", "stop"],
    pricing: { prompt: "0", completion: "0" },
    businesses: ["tokenplan"],
    description:
      "Lightweight native-multimodal agent model for delegated workflows: sub-agent orchestration, tool use and self-correction. Accepts text and image input.",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 1048576,
    max_output_length: 65536,
    supported_features: ["tools", "json_mode", "reasoning"],
    supported_sampling_parameters: ["temperature", "stop"],
    pricing: { prompt: "0", completion: "0" },
    businesses: ["tokenplan"],
    description: "DeepSeek high-performance conversational model, thinking and non-thinking modes, 1M context, tool calling.",
  },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 1048576,
    max_output_length: 65536,
    supported_features: ["tools", "json_mode", "reasoning"],
    supported_sampling_parameters: ["temperature", "stop"],
    pricing: { prompt: "0", completion: "0" },
    businesses: ["tokenplan"],
    description: "DeepSeek V4.1 Flash. May require a higher token plan; the gateway returns permission_denied_error otherwise.",
  },
  {
    id: "glm-5.2",
    name: "GLM 5.2",
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 1048576,
    max_output_length: 131072,
    supported_features: ["tools", "json_mode", "reasoning"],
    supported_sampling_parameters: ["temperature", "stop"],
    pricing: { prompt: "0", completion: "0" },
    businesses: ["tokenplan"],
    description: "Flagship long-horizon model with a usable 1M context and 128K output; strongest for end-to-end coding tasks.",
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 1048576,
    max_output_length: 65536,
    supported_features: ["tools", "json_mode", "reasoning"],
    supported_sampling_parameters: ["temperature", "stop"],
    pricing: { prompt: "0", completion: "0" },
    businesses: ["tokenplan"],
    description: "Kimi K3 conversational model with 1M context and tool calling.",
  },
  {
    id: "sensenova-u1-fast",
    name: "SenseNova U1 Fast",
    input_modalities: ["text"],
    output_modalities: ["image"],
    context_length: 262144,
    max_output_length: 65536,
    supported_features: [],
    supported_sampling_parameters: ["temperature", "stop"],
    pricing: { prompt: "0", completion: "0", image: "0" },
    businesses: ["tokenplan"],
    description: "Accelerated SenseNova U1 image generator for infographics. Uses /v1/images/generations.",
  },
  {
    id: "sensenova-u1.5-lite",
    name: "SenseNova U1.5 Lite",
    input_modalities: ["text"],
    output_modalities: ["image"],
    context_length: 262144,
    max_output_length: 65536,
    supported_features: [],
    supported_sampling_parameters: ["temperature", "stop"],
    pricing: { prompt: "0", completion: "0", image: "0" },
    businesses: ["tokenplan"],
    description: "Accelerated SenseNova U1.5 image generator. Also supports reference-image edits.",
  },
];

const SEED_MODELS = SEED_CATALOG.map(toPiModel).filter(Boolean);

// ---------------------------------------------------------------------------
// Live model discovery
// ---------------------------------------------------------------------------

function apiKeyFromCredential(credential) {
  return typeof credential?.key === "string" && credential.key ? credential.key : undefined;
}

async function fetchCatalog(context) {
  const key = apiKeyFromCredential(context?.credential) ?? process.env[API_KEY_ENV];
  if (!key) {
    throw new Error(`${API_KEY_ENV} is not set; run \`pi /login sensenova\` or export ${API_KEY_ENV}.`);
  }

  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: context?.signal,
  });
  if (!res.ok) throw new Error(`GET ${BASE_URL}/models failed: HTTP ${res.status} ${res.statusText}`.trim());

  const payload = await res.json();
  const records = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return records.map(toPiModel).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

function latestUserContent(context) {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  return [...messages].reverse().find((message) => message?.role === "user");
}

/**
 * pi's ImagesContext for generateImages() is { input: [...] } rather than a
 * chat transcript, so prompts arrive there. Fall back to the last user message
 * for callers that hand a transcript instead.
 */
function extractPromptAndReferences(context) {
  const blocks = Array.isArray(context?.input) ? context.input : [];
  const prompt = blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();

  const references = blocks
    .filter((block) => block?.type === "image" && typeof block.data === "string" && block.data.length > 0)
    .map((block) => ({ data: block.data, mimeType: block.mimeType ?? "image/png" }));

  if (prompt) return { prompt, references };

  const user = latestUserContent(context);
  const fallbackPrompt =
    typeof user?.content === "string"
      ? user.content
      : Array.isArray(user?.content)
        ? user.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
        : "";
  return {
    prompt: fallbackPrompt.trim(),
    references: (user?.content ?? [])
      .filter((part) => part?.type === "image" && typeof part.data === "string")
      .map((part) => ({ data: part.data, mimeType: part.mimeType ?? "image/png" })),
  };
}

async function saveGeneratedImage(image, modelId) {
  const directory = join(process.cwd(), ".pi", "generated-images");
  await mkdir(directory, { recursive: true });
  const mime = image?.mimeType ?? "image/png";
  const extension = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
  const filePath = join(directory, `${modelId.replace(/[^\w.-]+/g, "_")}-${Date.now()}.${extension}`);
  if (image?.b64_json) {
    await writeFile(filePath, Buffer.from(image.b64_json, "base64"));
  } else if (image?.url) {
    const download = await fetch(image.url);
    if (!download.ok) throw new Error(`Unable to download generated image: HTTP ${download.status}`);
    await writeFile(filePath, Buffer.from(await download.arrayBuffer()));
  } else {
    throw new Error("SenseNova image API returned neither url nor b64_json");
  }
  return filePath;
}

function parseImageUsage(rawUsage, model) {
  if (!rawUsage) return undefined;
  const input = Math.max(0, Math.floor(Number(rawUsage.input_tokens) || 0));
  const output = Math.max(0, Math.floor(Number(rawUsage.output_tokens) || 0));
  const total = Math.max(0, Math.floor(Number(rawUsage.total_tokens) || input + output));
  const cost = {
    input: (model.cost.input / 1e6) * input,
    output: (model.cost.output / 1e6) * output,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost };
}

function fileLink(path, label) {
  return `[${label ?? path}](${pathToFileURL(String(path)).href})`;
}

/**
 * SenseNova image generation over /v1/images/generations and /v1/images/edits.
 * Returns base64 so pi can render the block natively, and also saves a durable
 * copy under .pi/generated-images because pi does not persist generated images
 * to disk itself.
 */
async function generateImages(model, context, options) {
  const output = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };

  try {
    const apiKey = options?.apiKey ?? process.env[API_KEY_ENV];
    if (!apiKey) throw new Error(`No API key for provider ${model.provider}; run \`pi /login ${PROVIDER_ID}\``);

    const { prompt, references } = extractPromptAndReferences(context);
    if (!prompt) throw new Error("Image generation requires a text prompt");

    const url = references.length
      ? `${BASE_URL}/images/edits`
      : `${BASE_URL}/images/generations`;
    let params = references.length
      ? {
          model: model.id,
          images: references.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })),
          prompt,
          n: 1,
          response_format: "b64_json",
          output_format: "png",
        }
      : {
          model: model.id,
          prompt,
          n: 1,
          response_format: "b64_json",
          output_format: "png",
        };

    const nextParams = await options?.onPayload?.(params, model);
    if (nextParams !== undefined) params = nextParams;

    const fetchImpl = options?.fetch ?? globalThis.fetch;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
      ...(options?.signal
        ? { signal: options.signal }
        : options?.timeoutMs !== undefined
          ? { signal: AbortSignal.timeout(options.timeoutMs) }
          : {}),
    });

    await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(payload?.error?.message ?? `SenseNova image API HTTP ${response.status}`);
    }

    const image = payload?.data?.[0];
    if (!image) throw new Error("SenseNova image API returned no image data");

    const mimeType = payload?.output_format === "webp" ? "image/webp" : "image/png";
    const savedPath = await saveGeneratedImage({ ...image, mimeType }, model.id);
    output.output.push({ type: "image", mimeType, data: image.b64_json });
    output.output.push({
      type: "text",
      text: `Generated image saved to ${fileLink(savedPath)}\nSize: ${payload?.size ?? "unknown"}`,
    });
    output.usage = parseImageUsage(payload?.usage, model);
    output.responseId = typeof payload?.id === "string" ? payload.id : undefined;
  } catch (error) {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi) {
  if (typeof Image === "function") {
    pi.registerEntryRenderer?.("sensenova-generated-image", (entry, _options, theme) => {
      const data = entry?.data ?? {};
      // The entry-renderer theme lacks fallbackColor(), which Image.render needs.
      const imageTheme =
        theme && typeof theme.fallbackColor === "function"
          ? theme
          : { fallbackColor: (s) => (theme && theme.fg ? theme.fg("toolOutput", s) : s) };
      try {
        const bytes = readFileSync(data.path).toString("base64");
        return new Image(bytes, data.mimeType || "image/png", imageTheme, {
          maxWidthCells: 80,
          maxHeightCells: 30,
        });
      } catch {
        if (typeof Markdown === "function") {
          return new Markdown(`Generated image unavailable: ${fileLink(data.path ?? "unknown path")}`, 1, 0, theme);
        }
        return data.path ?? "unknown path";
      }
    });
  }

  const auth = {
    apiKey: {
      name: "SenseNova API key",
      login: async (interaction) => {
        const key = await interaction.prompt({
          type: "secret",
          message: "SenseNova API key",
          placeholder: "sk-...",
        });
        const trimmed = key.trim();
        if (!trimmed) throw new Error("SenseNova API key cannot be empty");
        return { type: "api_key", key: trimmed };
      },
      resolve: async ({ ctx, credential }) => {
        const key = apiKeyFromCredential(credential) ?? (await ctx.env(API_KEY_ENV));
        return key ? { auth: { apiKey: key }, source: credential?.key ? "stored API key" : API_KEY_ENV } : undefined;
      },
    },
  };

  const provider = createProvider({
    id: PROVIDER_ID,
    name: "SenseNova",
    baseUrl: BASE_URL,
    auth,
    models: SEED_MODELS,
    fetchModels: fetchCatalog,
    api: {
      [RESPONSES_API]: openAIResponsesApi(),
      [COMPLETIONS_API]: openAICompletionsApi(),
    },
    images: {
      [IMAGE_API]: { generateImages },
    },
  });

  pi.registerProvider(provider);

  registerModelCommands(pi);
  registerRefreshCommand(pi);
  registerUsageCommand(pi);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CAPABILITY_FILTERS = {
  reasoning: (model) => model.reasoning === true,
  vision: (model) => Array.isArray(model.input) && model.input.includes("image"),
  image: (model) => model.type === "image",
  responses: (model) => model.api === RESPONSES_API,
  tools: (model) => {
    const meta = model.sensenova;
    return meta ? meta.features.includes("tools") : true;
  },
};

function showMarkdown(pi, ctx, key, markdown) {
  if (ctx?.mode === "tui") pi.appendEntry(key, { markdown });
  else if (ctx?.hasUI) ctx.ui.notify(markdown, "info");
  else console.log(markdown);
}

function registerMarkdownRenderer(pi, key) {
  if (typeof Markdown !== "function" || typeof getMarkdownTheme !== "function") return;
  pi.registerEntryRenderer?.(key, (entry) =>
    new Markdown(entry.data?.markdown ?? "", 1, 0, getMarkdownTheme()),
  );
}

function formatSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** pi costs are USD per million tokens. */
function formatPrice(perMillion) {
  const n = Number(perMillion);
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toFixed(2)}`;
}

function allModels(ctx) {
  const registry = ctx?.modelRegistry;
  const registered = (registry?.getAll?.() ?? []).filter((model) => model.provider === PROVIDER_ID);
  if (registered.length > 0) return registered;
  const typed = registry?.getModelsOfType
    ? [...registry.getModelsOfType("chat"), ...registry.getModelsOfType("image")].filter(
        (model) => model.provider === PROVIDER_ID,
      )
    : [];
  return typed.length > 0 ? typed : SEED_MODELS;
}

function registerModelCommands(pi) {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("sensenova-models", {
    description:
      "List SenseNova models. Optional filter: reasoning, vision, image, responses, tools.",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const filter = tokens.find((token) => token in CAPABILITY_FILTERS);
      const mark = (value) => (value ? "✓" : "—");

      const rows = allModels(ctx)
        .filter((model) => !filter || CAPABILITY_FILTERS[filter](model))
        .sort((a, b) => a.id.localeCompare(b.id));

      const markdown = [
        `# SenseNova models${filter ? ` (filter: ${filter})` : ""}`,
        "",
        `Provider \`${PROVIDER_ID}\` · ${rows.length} model${rows.length === 1 ? "" : "s"}`,
        "",
        "| Model | Type | API | Reasoning | Vision | Ctx | Max Out | In $/M | Out $/M |",
        "|---|---|---|:---:|:---:|---:|---:|---:|---:|",
        ...rows.map((model) => {
          const isImage = model.type === "image";
          return `| \`${model.id}\` | ${isImage ? "image" : "chat"} | ${model.api === RESPONSES_API ? "responses" : model.api === COMPLETIONS_API ? "chat-completions" : model.api} | ${mark(model.reasoning)} | ${mark(
            Array.isArray(model.input) && model.input.includes("image"),
          )} | ${formatSize(model.contextWindow ?? 0)} | ${formatSize(model.maxTokens ?? 0)} | ${formatPrice(model.cost?.input)} | ${formatPrice(model.cost?.output)} |`;
        }),
        "",
        "_`responses` = OpenAI Responses API (\\`/v1/responses\\`), `chat-completions` = `/v1/chat/completions`. " +
          "Prices are USD per million tokens; SenseNova reports 0 during the token-plan preview._",
        rows.length ? "" : "_No models match the filter._",
      ].join("\n");
      showMarkdown(pi, ctx, "sensenova-models", markdown);
    },
  });
  registerMarkdownRenderer(pi, "sensenova-models");
}

function registerRefreshCommand(pi) {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("sensenova-refresh", {
    description: "Re-fetch the model catalog from the SenseNova /v1/models endpoint.",
    handler: async (_args, ctx) => {
      const registry = ctx?.modelRegistry;
      if (typeof registry?.refresh !== "function") {
        ctx?.ui?.notify("Model registry is not available.", "warning");
        return;
      }

      const started = Date.now();
      const result = await registry.refresh({
        providers: [PROVIDER_ID],
        force: true,
        signal: ctx.signal ?? new AbortSignal(),
      });
      const errors = result?.errors instanceof Map ? [...result.errors.values()] : [];
      const elapsed = Math.round((Date.now() - started) / 100) / 10;

      const models = allModels(ctx);
      const count = models.length;
      const ok = errors.length === 0 && !result?.aborted;

      const markdown = [
        "# SenseNova catalog refresh",
        "",
        ok
          ? `✅ Updated in ${elapsed}s — ${count} model${count === 1 ? "" : "s"} registered.`
          : `⚠️  Refresh failed after ${elapsed}s — keeping ${count} cached model${count === 1 ? "" : "s"}.`,
        "",
        ...errors.map((error) => `- \`${error instanceof Error ? error.message : String(error)}\``),
        "",
        "Run `/sensenova-models` to see the current catalog.",
      ].join("\n");
      showMarkdown(pi, ctx, "sensenova-refresh", markdown);
      registerMarkdownRenderer(pi, "sensenova-refresh");
    },
  });
  registerMarkdownRenderer(pi, "sensenova-refresh");
}

// SenseNova exposes no account-level billing endpoint through this provider, so
// usage is accumulated from completed assistant messages in this process only.
const SESSION_USAGE = new Map();
let usageHookInstalled = false;

function installUsageTracker(pi) {
  if (usageHookInstalled || typeof pi.on !== "function") return;
  usageHookInstalled = true;

  pi.on("message_end", (event) => {
    const message = event?.message;
    if (message?.role !== "assistant" || message.provider !== PROVIDER_ID) return;

    const key = `${message.provider}/${message.model}`;
    const row = SESSION_USAGE.get(key) ?? {
      provider: message.provider,
      model: message.model,
      turns: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      cost: 0,
    };

    const usage = message.usage ?? {};
    const input = Number(usage.input) || 0;
    const output = Number(usage.output) || 0;
    row.turns += 1;
    row.input += input;
    row.output += output;
    row.reasoning += Number(usage.reasoning) || 0;
    row.total += Number(usage.totalTokens) || input + output;
    row.cost += Number(usage.cost?.total) || 0;
    SESSION_USAGE.set(key, row);
  });
}

function registerUsageCommand(pi) {
  installUsageTracker(pi);
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("sensenova-usage", {
    description: "Show SenseNova token and cost usage accumulated in this Pi process.",
    handler: async (_args, ctx) => {
      const rows = [...SESSION_USAGE.values()].sort((a, b) => a.model.localeCompare(b.model));
      const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);

      const markdown = [
        "# SenseNova session usage",
        "",
        "_Tokens reported by completed assistant messages in this Pi process, not a SenseNova account invoice._",
        "",
        "| Model | Turns | Input | Reasoning | Output | Total | Cost |",
        "|---|---:|---:|---:|---:|---:|---:|",
        ...rows.map(
          (row) =>
            `| \`${row.model}\` | ${row.turns} | ${row.input.toLocaleString()} | ${row.reasoning.toLocaleString()} | ${row.output.toLocaleString()} | ${row.total.toLocaleString()} | $${row.cost.toFixed(6)} |`,
        ),
        "",
        rows.length ? `**Session total:** $${totalCost.toFixed(6)}` : "_No SenseNova usage recorded in this process yet._",
      ].join("\n");
      showMarkdown(pi, ctx, "sensenova-usage", markdown);
      registerMarkdownRenderer(pi, "sensenova-usage");
    },
  });
  registerMarkdownRenderer(pi, "sensenova-usage");
}

// ---------------------------------------------------------------------------
// Exports for tests and out-of-process tooling
// ---------------------------------------------------------------------------

export const __testing = {
  PROVIDER_ID,
  BASE_URL,
  RESPONSES_API,
  COMPLETIONS_API,
  IMAGE_API,
  RESPONSES_MODELS,
  GRAMMAR_OUTPUT_MODELS,
  RESPONSES_THINKING_LEVELS,
  COMPLETIONS_THINKING_LEVELS,
  SEED_CATALOG,
  SEED_MODELS,
  toPiModel,
  parseCost,
  extractPromptAndReferences,
  parseImageUsage,
  generateImages,
};
