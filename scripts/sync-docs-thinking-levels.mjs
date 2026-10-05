#!/usr/bin/env node
/**
 * Automatically inspects https://platform.sensenova.cn/docs, locates the
 * active Next.js documentation bundle, extracts official thinking level
 * (reasoning_effort) specifications for each model, and outputs a report.
 *
 * Usage:
 *   npm run sync-docs
 *   node scripts/sync-docs-thinking-levels.mjs
 */

const DOCS_URL = "https://platform.sensenova.cn/docs";
const BASE_ORIGIN = "https://platform.sensenova.cn";

const KNOWN_MODELS = [
  "sensenova-6.8-flash-lite",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "deepseek-flash",
  "glm-5.2",
  "kimi-k3",
];

const STANDARD_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return res.text();
}

async function extractDocBundleText() {
  console.log(`[sync-docs] Fetching documentation index from ${DOCS_URL}...`);
  const html = await fetchHtml(DOCS_URL);
  const chunks = Array.from(new Set(html.match(/static\/chunks\/[a-zA-Z0-9_\-\.]+\.js/g) || []));
  console.log(`[sync-docs] Discovered ${chunks.length} Next.js JavaScript chunks.`);

  for (const chunk of chunks) {
    const chunkUrl = `${BASE_ORIGIN}/_next/${chunk}`;
    const text = await fetchHtml(chunkUrl);
    if (text.includes("reasoning_effort") && text.includes("{#model-")) {
      console.log(`[sync-docs] Found documentation payload inside chunk: ${chunk}`);
      return text;
    }
  }

  throw new Error("Could not find documentation bundle containing model documentation");
}

function parseModelEfforts(bundleText) {
  // Use {#model-...} boundaries to prevent cross-model bleeding
  const pattern = /## [^#\n]+?\{#model-[^}]+?\}/g;
  const matches = Array.from(bundleText.matchAll(pattern));

  const results = {};

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : bundleText.length;
    const section = bundleText.slice(start, end).replace(/\\n/g, "\n").replace(/\\"/g, '"');

    const midMatch = section.match(/model_id[：:]\s*`?([a-zA-Z0-9_\-\.]+)/i);
    if (!midMatch) continue;
    const modelId = midMatch[1].toLowerCase();
    if (results[modelId]) continue; // Prefer the first complete definition

    const rowMatch = section.match(/\|\s*`?reasoning_effort`?[^|\n]*\|([^\n]+)/i);
    if (!rowMatch) continue;

    const rowText = rowMatch[0];
    const found = STANDARD_EFFORTS.filter((eff) => {
      const re = new RegExp(`(?:^|[^a-zA-Z0-9_-])${eff}(?:$|[^a-zA-Z0-9_-])`, "i");
      return re.test(rowText);
    });

    // Check if disabling thinking ("none") is described in the surrounding thinking mode section
    if (!found.includes("none")) {
      const rowIdx = section.indexOf(rowText);
      const surrounding = section.slice(Math.max(0, rowIdx - 500), Math.min(section.length, rowIdx + 2500));
      if (
        /none/i.test(surrounding) &&
        (/关闭/i.test(surrounding) || /disable/i.test(surrounding) || /turn off/i.test(surrounding) || /"reasoning_effort":\s*"none"/i.test(surrounding))
      ) {
        found.unshift("none");
      }
    }

    if (found.length > 0) {
      results[modelId] = found;
    }
  }

  // Handle variants that share family documentation (e.g. deepseek-v4-pro shares deepseek-v4-flash)
  for (const modelId of KNOWN_MODELS) {
    if (!results[modelId]) {
      if (modelId.startsWith("deepseek-v4") && results["deepseek-v4-flash"]) {
        results[modelId] = [...results["deepseek-v4-flash"]];
        console.log(`[sync-docs] ${modelId} inherited from deepseek-v4-flash documentation.`);
      }
    }
  }

  return results;
}

async function main() {
  try {
    const text = await extractDocBundleText();
    const specs = parseModelEfforts(text);

    console.log("\n[sync-docs] Extracted thinking levels from official documentation:\n");
    console.table(
      KNOWN_MODELS.map((model) => ({
        Model: model,
        "Documented Efforts": (specs[model] || []).join(", ") || "NOT FOUND",
      })),
    );

    console.log("\nJavaScript definition snippet:\n");
    console.log("const DOC_MODEL_REASONING_EFFORTS = " + JSON.stringify(specs, null, 2) + ";");
  } catch (err) {
    console.error("[sync-docs] Error:", err.message);
    process.exit(1);
  }
}

main();
