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
  "deepseek-v4-pro",
  "deepseek-flash",
  "glm-5.2",
  "kimi-k3",
]);

/**
 * Lark grammar-constrained tool output causes `compile_grammar_error` in
 * SenseNova's tokenizer. Grammar tools are disabled across all models so
 * standard, reliable JSON schema tool definitions are used instead.
 */
const GRAMMAR_OUTPUT_MODELS = new Set([]);

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
 * which uses standard OpenAI reasoning_effort.
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
// Client-side rate limiting
//
// The SenseNova gateway throttles per model and per endpoint (observed errors:
// `inference exceeds tpm/rpm limit`, `rps exhausted`,
// `RateLimitExceeded.EndpointRPMExceeded`, `inference tpm exhausted`) and does
// not return a `Retry-After` header, so there is nothing server-supplied to pace
// ourselves by. A shared per-model token bucket keeps the request rate under the
// limit before it is reached, and a 429 opens a cooldown so the next requests
// wait instead of piling onto the throttled endpoint.
//
// Quota exhaustion is a different failure and is never retried: the free quota is
// a per-model sliding window (1,500 calls / 5 hours) and waiting inside the
// window does not recover it.
// ---------------------------------------------------------------------------

function boolFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

function toIntAllowZero(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const RATE_LIMIT = {
  enabled: boolFromEnv("SENSENOVA_RATE_LIMIT", true),
  /** Requests per minute allowed per model id. */
  rpm: toInt(process.env.SENSENOVA_RPM, 20),
  /** Burst tokens available before the per-minute refill starts governing. */
  burst: toInt(process.env.SENSENOVA_BURST, 2),
  /** Give up waiting for a bucket slot after this long and send anyway. */
  maxWaitMs: toInt(process.env.SENSENOVA_MAX_WAIT_MS, 180_000),
  /** Retries for transient 429/5xx inside the fetch wrapper. */
  retries: toIntAllowZero(process.env.SENSENOVA_MAX_RETRIES, 2),
  backoffBaseMs: toInt(process.env.SENSENOVA_BACKOFF_BASE_MS, 1_500),
  backoffMaxMs: toInt(process.env.SENSENOVA_BACKOFF_MAX_MS, 30_000),
  cooldownBaseMs: toInt(process.env.SENSENOVA_COOLDOWN_BASE_MS, 15_000),
  cooldownMaxMs: toInt(process.env.SENSENOVA_COOLDOWN_MAX_MS, 120_000),
};

function abortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Abortable sleep. The timer must stay referenced: it is the only thing keeping
 * the event loop alive while a request is parked waiting for a bucket token,
 * and an unref'd timer lets Node exit with the request still pending.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** OpenAI `Retry-After` is either an integer number of seconds or an HTTP date. */
function parseRetryAfterMs(headers) {
  if (!headers) return undefined;
  const raw = typeof headers.get === "function" ? headers.get("retry-after") : headers["retry-after"];
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Math.floor(Number(text) * 1000);
  // Only attempt a date when the value actually looks like one; V8's
  // Date.parse happily turns "3.5" into a valid year.
  if (/[a-z]/i.test(text)) {
    const when = Date.parse(text);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  return undefined;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * SenseNova uses the same 429 status for two very different failures. Only the
 * first is worth waiting on; the second is a quota boundary that no in-window
 * wait recovers.
 */
const QUOTA_EXHAUSTED =
  /free_quota_exhausted|quota exhausted|plan limit exhausted|token plan limit|usage limit|monthly limit/i;

function isQuotaExhausted(status, body) {
  // 403 is an authorization/plan error, not a rate limit or sliding window quota
  // issue. It must never trigger a quota cooldown.
  if (status === 403 || Number(status) === 403) return false;
  return QUOTA_EXHAUSTED.test(body);
}

function firstLine(text) {
  const line = String(text).replace(/\s+/g, " ").trim();
  return line.slice(0, 300) || "unknown error";
}

class ModelBucket {
  constructor(modelId, config) {
    this.modelId = modelId;
    this.rpm = config.rpm;
    this.burst = Math.max(1, config.burst);
    this.tokens = this.burst;
    this.lastRefill = Date.now();
    this.cooldownUntil = 0;
    this.consecutiveThrottles = 0;
    this.requests = 0;
    this.rateLimited = 0;
    this.retries = 0;
    this.totalWaitedMs = 0;
    this.lastRateLimitedAt = 0;
    this.lastAcquiredAt = 0;
  }

  get msPerRequest() {
    return 60_000 / this.rpm;
  }

  refill(now) {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed / this.msPerRequest);
    this.lastRefill = now;
  }

  /** Milliseconds until this bucket will accept another request. */
  waitMs(now) {
    if (this.cooldownUntil > now) return this.cooldownUntil - now;
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return (1 - this.tokens) * this.msPerRequest;
  }

  take(now) {
    // Refilling here would hand back the token a caller just spent, so the
    // burst would never be observable. waitMs() refills before deciding.
    this.tokens = Math.max(0, this.tokens - 1);
    this.requests += 1;
    this.lastAcquiredAt = now;
  }
}

class RateLimiter {
  constructor(config) {
    this.config = config;
    this.buckets = new Map();
  }

  bucket(modelId) {
    let bucket = this.buckets.get(modelId);
    if (!bucket) {
      bucket = new ModelBucket(modelId, this.config);
      this.buckets.set(modelId, bucket);
    }
    return bucket;
  }

  /**
   * Wait until the model has a bucket token. Aborts propagate; exceeding
   * maxWaitMs sends anyway so the gateway can answer with a real 429 and
   * update the cooldown, rather than hanging indefinitely.
   */
  async acquire(modelId, signal) {
    if (!this.config.enabled) return;
    const bucket = this.bucket(modelId);
    const started = Date.now();

    for (;;) {
      if (signal?.aborted) return;
      const now = Date.now();
      const wait = bucket.waitMs(now);

      if (wait <= 0) {
        bucket.take(now);
        if (bucket.cooldownUntil <= now) bucket.consecutiveThrottles = 0;
        return;
      }

      const remaining = this.config.maxWaitMs - (now - started);
      if (remaining <= 0) {
        bucket.take(now);
        return;
      }

      const step = Math.min(wait, remaining);
      bucket.totalWaitedMs += step;
      try {
        await sleep(step, signal);
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) return;
        throw error;
      }
    }
  }

  /**
   * Record a throttle on the model. Consecutive throttles escalate the cooldown
   * geometrically so the model stays quiet instead of re-probing every tick.
   * Returns the cooldown applied, in ms.
   */
  onRateLimited(modelId, headers, { status } = {}) {
    const bucket = this.bucket(modelId);
    const now = Date.now();
    const requested = parseRetryAfterMs(headers);
    const escalated = this.config.cooldownBaseMs * 2 ** bucket.consecutiveThrottles;
    const cooldown = Math.min(Math.max(escalated, requested ?? 0), this.config.cooldownMaxMs);
    bucket.cooldownUntil = Math.max(bucket.cooldownUntil, now + cooldown);
    bucket.consecutiveThrottles += 1;
    bucket.rateLimited += 1;
    bucket.lastRateLimitedAt = now;
    bucket.lastStatus = status ?? undefined;
    return cooldown;
  }

  onRetried(modelId) {
    this.bucket(modelId).retries += 1;
  }

  /**
   * A quota boundary: park the model for well over the cooldown cap so a
   * higher-level retry does not hammer an endpoint that cannot recover.
   */
  onQuotaExhausted(modelId, headers, status) {
    if (status === 403 || Number(status) === 403) return 0;
    const bucket = this.bucket(modelId);
    const now = Date.now();
    const cooldown = this.onRateLimited(modelId, headers, { status });
    bucket.cooldownUntil = Math.max(bucket.cooldownUntil, now + Math.max(this.config.cooldownMaxMs, 10 * 60_000));
    bucket.consecutiveThrottles = 0;
    bucket.lastStatus = status ?? undefined;
    return cooldown;
  }

  onSucceeded(modelId) {
    const bucket = this.bucket(modelId);
    bucket.consecutiveThrottles = 0;
    bucket.lastStatus = undefined;
  }

  reset(modelId) {
    if (modelId) this.buckets.delete(modelId);
    else this.buckets.clear();
  }

  snapshot() {
    return [...this.buckets.values()]
      .sort((a, b) => a.modelId.localeCompare(b.modelId))
      .map((bucket) => ({
        model: bucket.modelId,
        requests: bucket.requests,
        rateLimited: bucket.rateLimited,
        retries: bucket.retries,
        tokens: Math.floor(bucket.tokens * 100) / 100,
        cooldownRemainingMs: Math.max(0, bucket.cooldownUntil - Date.now()),
        consecutiveThrottles: bucket.consecutiveThrottles,
        totalWaitedMs: Math.round(bucket.totalWaitedMs),
        lastRateLimitedAt: bucket.lastRateLimitedAt || undefined,
      }));
  }
}

const rateLimiter = new RateLimiter(RATE_LIMIT);

function describeHttpError(status, body) {
  if (isQuotaExhausted(status, body)) {
    return `quota exhausted: ${firstLine(body)}. Waiting does not recover this; the free quota is a per-model sliding window. Check the Token Plan console.`;
  }
  if (status === 429) {
    return `rate limited: ${firstLine(body)}. The model is throttled and queued requests will back off.`;
  }
  return firstLine(body);
}

/**
 * Re-emit a consumed error response. pi-ai formats the provider error from the
 * status and body, so the response has to come back intact rather than being
 * replaced by a thrown error (which the OpenAI SDK would collapse into a bare
 * "Connection error.").
 */
function errorResponse(status, body, detail) {
  const text = body.trim().startsWith("{")
    ? JSON.stringify({ error: { message: detail } })
    : `{"error":{"message":"${detail.replace(/"/g, "\\\"").replace(/\n/g, " ")}"}}`;
  return new Response(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Remove proprietary OpenAI Responses fields not accepted by the SenseNova
 * Responses gateway (`reasoning.encrypted_content` and `prompt_cache_key`).
 */
function sanitizeResponsesParams(params) {
  if (!params || typeof params !== "object") return params;
  if (Array.isArray(params.include)) {
    const filtered = params.include.filter((item) => item !== "reasoning.encrypted_content");
    if (filtered.length > 0) {
      params.include = filtered;
    } else {
      delete params.include;
    }
  }
  if ("prompt_cache_key" in params) {
    delete params.prompt_cache_key;
  }
  if ("prompt_cache_retention" in params) {
    delete params.prompt_cache_retention;
  }
  if ("prompt_cache_options" in params) {
    delete params.prompt_cache_options;
  }
  if (params.reasoning && typeof params.reasoning === "object") {
    delete params.reasoning.summary;
  }
  return params;
}

/**
 * Wraps the caller's fetch so every outbound request is paced and retried.
 * Injected through pi-ai's `options.fetch`, which both built-in OpenAI adapters
 * pass straight to the OpenAI client.
 */
function makeRateLimitedFetch(modelId, inner) {
  if (!RATE_LIMIT.enabled) return inner;
  const target = typeof inner === "function" ? inner : globalThis.fetch.bind(globalThis);
  if (!modelId) return target;

  return async (input, init) => {
    const signal = init?.signal;
    await rateLimiter.acquire(modelId, signal);

    let finalInit = init;
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";
    if (urlStr.includes("/responses") && init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body);
        sanitizeResponsesParams(parsed);
        finalInit = { ...init, body: JSON.stringify(parsed) };
      } catch {
        // Keep original body if parsing fails.
      }
    }

    for (let attempt = 0; ; attempt++) {
      const response = await target(input, finalInit);

      if (response.status === 403) {
        // 403 is an authorization/plan issue, not a rate limit or sliding window quota
        // issue. Fail fast immediately without retry or placing the bucket in cooldown.
        const bucket = rateLimiter.bucket(modelId);
        if (bucket.cooldownUntil > Date.now()) {
          bucket.cooldownUntil = 0;
        }
        rateLimiter.onSucceeded(modelId);
        return response;
      }

      if (!RETRYABLE_STATUS.has(response.status)) {
        rateLimiter.onSucceeded(modelId);
        return response;
      }

      // The body is consumed and discarded so the response can be re-sent.
      let body = "";
      try {
        body = (await response.text()) ?? "";
      } catch {
        body = "";
      }

      const quotaExhausted = isQuotaExhausted(response.status, body);
      if (quotaExhausted) {
        rateLimiter.onQuotaExhausted(modelId, response.headers, response.status);
        return errorResponse(response.status, body, describeHttpError(response.status, body));
      }

      if (attempt >= RATE_LIMIT.retries || signal?.aborted) {
        rateLimiter.onRateLimited(modelId, response.headers, { status: response.status });
        return errorResponse(response.status, body, describeHttpError(response.status, body));
      }

      rateLimiter.onRetried(modelId);
      const cooldown = rateLimiter.onRateLimited(modelId, response.headers, {
        status: response.status,
      });
      const exponential = Math.min(
        RATE_LIMIT.backoffMaxMs,
        RATE_LIMIT.backoffBaseMs * 2 ** attempt,
      );
      const jitter = exponential * (0.25 + Math.random() * 0.5);
      // Never retry sooner than the cooldown the throttle just imposed.
      const waitMs = Math.min(
        Math.max(jitter, cooldown),
        RATE_LIMIT.maxWaitMs,
      );
      await sleep(waitMs, signal);
    }
  };
}

/** Wraps a pi-ai ProviderStreams pair so all its requests go through the limiter. */
function withRateLimit(streams) {
  if (!RATE_LIMIT.enabled || !streams || typeof streams !== "object") return streams;
  const wrap = (fn) => {
    if (typeof fn !== "function") return fn;
    return (model, context, options) => {
      const { fetch: callerFetch, onPayload: callerOnPayload, ...rest } = options ?? {};
      const onPayload = async (params, m) => {
        let transformed = params;
        if ((m?.api ?? model?.api) === RESPONSES_API) {
          transformed = sanitizeResponsesParams(transformed);
        }
        if (typeof callerOnPayload === "function") {
          const res = await callerOnPayload(transformed, m);
          if (res !== undefined) transformed = res;
        }
        return transformed;
      };
      return fn(model, context, {
        ...rest,
        onPayload,
        fetch: makeRateLimitedFetch(model?.id, callerFetch),
      });
    };
  };
  const out = { ...streams };
  if (typeof streams.stream === "function") out.stream = wrap(streams.stream);
  if (typeof streams.streamSimple === "function") out.streamSimple = wrap(streams.streamSimple);
  return out;
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
  const features = new Set(stringArray(raw.supported_features, []).map((f) => f.toLowerCase()));
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
    api: outputImage
      ? IMAGE_API
      : (RESPONSES_MODELS.has(id) || /^(sensenova|deepseek|glm-|kimi)/i.test(id))
        ? RESPONSES_API
        : COMPLETIONS_API,
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
    /^(sensenova|deepseek|glm-|kimi)/i.test(id);

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
            supportsOpenAIGrammarTools: false,
          }
        : {
            thinkingFormat: "openai",
            supportsStore: false,
            requiresReasoningContentOnAssistantMessages: true,
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
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 1048576,
    max_output_length: 131072,
    supported_features: ["tools", "json_mode", "reasoning"],
    supported_sampling_parameters: ["temperature", "stop"],
    pricing: { prompt: "0", completion: "0" },
    businesses: ["tokenplan"],
    description: "DeepSeek V4 Pro conversational model with 1M context, 128K output and reasoning.",
  },
  {
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 1048576,
    max_output_length: 65536,
    supported_features: ["tools", "json_mode", "reasoning"],
    supported_sampling_parameters: ["temperature", "stop"],
    pricing: { prompt: "0", completion: "0" },
    businesses: ["tokenplan"],
    description: "DeepSeek Flash conversational model with 1M context and reasoning.",
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

  const user = latestUserContent(context);
  const fallbackPrompt =
    typeof user?.content === "string"
      ? user.content
      : Array.isArray(user?.content)
        ? user.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
        : "";
  const userReferences = (Array.isArray(user?.content) ? user.content : [])
    .filter((part) => part?.type === "image" && typeof part.data === "string" && part.data.length > 0)
    .map((part) => ({ data: part.data, mimeType: part.mimeType ?? "image/png" }));

  return {
    prompt: (prompt || fallbackPrompt).trim(),
    references: references.length > 0 ? references : userReferences,
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

    const base = (model.baseUrl ? model.baseUrl.replace(/\/images\/?$/, "") : BASE_URL).replace(/\/+$/, "");
    const url = references.length
      ? `${base}/images/edits`
      : `${base}/images/generations`;
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

    const fetchImpl = makeRateLimitedFetch(model.id, options?.fetch);
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
      [RESPONSES_API]: withRateLimit(openAIResponsesApi()),
      [COMPLETIONS_API]: withRateLimit(openAICompletionsApi()),
    },
    images: {
      [IMAGE_API]: { generateImages },
    },
  });

  pi.registerProvider(provider);

  registerModelCommands(pi);
  registerRefreshCommand(pi);
  registerUsageCommand(pi);
  registerThrottleCommand(pi);
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
      // `new AbortSignal()` throws in Node (ERR_ILLEGAL_CONSTRUCTOR); pi supplies
      // its own signal when the caller omits one, so just leave it out.
      const result = await registry.refresh({
        providers: [PROVIDER_ID],
        force: true,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
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
// Rate limiting status
// ---------------------------------------------------------------------------

function formatDuration(ms) {
  if (ms <= 0) return "—";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function registerThrottleCommand(pi) {
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("sensenova-throttle", {
    description:
      "Show client-side rate limiting state per model. Argument `reset` clears all cooldowns.",
    handler: async (args, ctx) => {
      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);
      const wantReset = tokens[0]?.toLowerCase() === "reset";
      if (wantReset) rateLimiter.reset();

      const rows = rateLimiter.snapshot();
      const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
      const totalLimited = rows.reduce((sum, row) => sum + row.rateLimited, 0);
      const totalRetries = rows.reduce((sum, row) => sum + row.retries, 0);
      const totalWaited = rows.reduce((sum, row) => sum + row.totalWaitedMs, 0);

      const settingsRows = RATE_LIMIT.enabled
        ? [
            "| Setting | Value |",
            "|---|---:|",
            `| Requests / minute per model | ${RATE_LIMIT.rpm} |`,
            `| Burst | ${RATE_LIMIT.burst} |`,
            `| Retry attempts | ${RATE_LIMIT.retries} |`,
            `| Backoff | ${formatDuration(RATE_LIMIT.backoffBaseMs)} \u2192 ${formatDuration(RATE_LIMIT.backoffMaxMs)} |`,
            `| Cooldown | ${formatDuration(RATE_LIMIT.cooldownBaseMs)} \u2192 ${formatDuration(RATE_LIMIT.cooldownMaxMs)} |`,
            `| Max wait for a slot | ${formatDuration(RATE_LIMIT.maxWaitMs)} |`,
          ]
        : [];

      const bucketRows = rows.length
        ? [
            "| Model | Requests | Limited | Retried | Tokens | Cooldown left | Waited |",
            "|---|---:|---:|---:|---:|---:|---:|",
            ...rows.map(
              (row) =>
                `| \`${row.model}\` | ${row.requests} | ${row.rateLimited} | ${row.retries} | ${row.tokens} | ${formatDuration(row.cooldownRemainingMs)} | ${formatDuration(row.totalWaitedMs)} |`,
            ),
            "",
            `**Totals:** ${totalRequests} requests, ${totalLimited} throttles, ${totalRetries} retries, ${formatDuration(totalWaited)} spent waiting.`,
          ]
        : ["_No requests sent from this process yet._"];

      const banner = wantReset
        ? "\u2705 Cooldowns cleared."
        : RATE_LIMIT.enabled
          ? ""
          : "Client-side rate limiting is disabled (`SENSENOVA_RATE_LIMIT=0`); requests go out unpaced.";

      const markdown = [
        `# SenseNova rate limiting${RATE_LIMIT.enabled ? "" : " (disabled)"}`,
        "",
        banner,
        "",
        ...settingsRows,
        "",
        ...bucketRows,
        "",
        "Tune with `SENSENOVA_RPM`, `SENSENOVA_BURST`, `SENSENOVA_MAX_RETRIES`,",
        "`SENSENOVA_COOLDOWN_MAX_MS`, or disable entirely with `SENSENOVA_RATE_LIMIT=0`.",
        "Pi's own `retry.provider.maxRetries` is a separate, orthogonal knob.",
      ]
        .filter((line) => line !== undefined)
        .join("\n");
      showMarkdown(pi, ctx, "sensenova-throttle", markdown);
      registerMarkdownRenderer(pi, "sensenova-throttle");
    },
  });
  registerMarkdownRenderer(pi, "sensenova-throttle");
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
  RATE_LIMIT,
  RateLimiter,
  rateLimiter,
  ModelBucket,
  makeRateLimitedFetch,
  withRateLimit,
  isQuotaExhausted,
  describeHttpError,
  errorResponse,
  parseRetryAfterMs,
  RETRYABLE_STATUS,
  sleep,
  sanitizeResponsesParams,
};
