// Live demonstration of the client-side rate limiter against the real gateway.
// Fires a burst of concurrent requests and reports how the limiter paced them.
import { __testing as sn } from "../extensions/sensenova.ts";

const { rateLimiter, makeRateLimitedFetch, BASE_URL } = sn;
const MODEL = process.env.LIVE_MODEL ?? "deepseek-flash";
const KEY = process.env.SENSENOVA_API_KEY;
if (!KEY) throw new Error("SENSENOVA_API_KEY is required");

const URL = `${BASE_URL}/chat/completions`;
const started = Date.now();
const stamp = (label, ...args) => console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`, ...args);

const concurrency = Number(process.env.LIVE_CONCURRENCY ?? 8);
console.log(`Firing ${concurrency} concurrent requests at ${MODEL} (rpm=${process.env.SENSENOVA_RPM ?? 20}, burst=${process.env.SENSENOVA_BURST ?? 2}):\n`);

const results = await Promise.all(
  Array.from({ length: concurrency }, (_, index) => {
    const queuedAt = Date.now() - started;
    stamp(`req${index} queued`, `#${(index + 1).toString().padStart(2)} queued, waiting for a bucket token`);
    return makeRateLimitedFetch(MODEL, globalThis.fetch)(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "1" }],
        max_tokens: 3,
      }),
    })
      .then(async (response) => ({
        index,
        queuedAt,
        settledAt: Date.now() - started,
        status: response.status,
        detail: response.status === 200 ? "ok" : (await response.json()).error?.message ?? "",
      }))
      .catch((error) => ({
        index,
        queuedAt,
        settledAt: Date.now() - started,
        error: String(error.message).slice(0, 70),
      }));
  }),
);

console.log("\nresults:");
for (const row of [...results].sort((a, b) => a.settledAt - b.settledAt)) {
  stamp(
    `  req${row.index} settled`,
    row.status !== undefined ? `HTTP ${row.status}` : row.error,
    `(queued ${row.queuedAt}ms, resolved after ${row.settledAt - row.queuedAt}ms)`,
    row.detail ?? "",
  );
}

const tally = results.reduce((total, row) => {
  const key = row.status !== undefined ? `HTTP ${row.status}` : "error";
  total[key] = (total[key] ?? 0) + 1;
  return total;
}, {});
console.log(`\nwall time: ${Date.now() - started}ms  tally: ${JSON.stringify(tally)}`);

console.log("\nlimiter snapshot:");
for (const row of rateLimiter.snapshot()) {
  stamp(
    `  ${row.model}`,
    `requests=${row.requests}`,
    `throttled=${row.rateLimited}`,
    `retried=${row.retries}`,
    `waited=${Math.round(row.totalWaitedMs)}ms`,
    `cooldownLeft=${Math.round(row.cooldownRemainingMs)}ms`,
    `escalations=${row.consecutiveThrottles}`,
  );
}
