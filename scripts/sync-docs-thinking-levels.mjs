#!/usr/bin/env node
/**
 * Automatically inspects https://platform.sensenova.cn/docs, locates the
 * active Next.js documentation bundle, extracts official thinking level
 * (reasoning_effort) specifications for each model, and outputs a report.
 *
 * Usage:
 *   node scripts/sync-docs-thinking-levels.mjs
 */

const DOCS_URL = "https://platform.sensenova.cn/docs";
const BASE_ORIGIN = "https://platform.sensenova.cn";

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
    if (text.includes("reasoning_effort") && (text.includes("思考模式") || text.includes("思考强度"))) {
      console.log(`[sync-docs] Found documentation payload inside chunk: ${chunk}`);
      return text;
    }
  }

  throw new Error("Could not find documentation bundle containing reasoning_effort");
}

function parseModelEfforts(bundleText) {
  const knownModels = [
    "sensenova-6.8-flash-lite",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    "deepseek-v4.1-flash",
    "deepseek-flash",
    "glm-5.2",
    "kimi-k3",
  ];

  const results = {};
  const standardEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

  for (const modelId of knownModels) {
    let searchPos = 0;
    while (searchPos < bundleText.length) {
      const idx = bundleText.indexOf(modelId, searchPos);
      if (idx === -1) break;

      const sub = bundleText.slice(idx, idx + 20000).replace(/\\n/g, "\n").replace(/\\"/g, '"');
      const reIdx = sub.search(/\|\s*`?reasoning_effort/i);
      if (reIdx !== -1) {
        const slice = sub.slice(reIdx, reIdx + 800);
        const found = standardEfforts.filter((eff) =>
          new RegExp(`(?:^|[^a-zA-Z0-9_-])${eff}(?:$|[^a-zA-Z0-9_-])`, "i").test(slice),
        );

        // Check if none/disable thinking is documented in the surrounding paragraph
        const surrounding = sub.slice(Math.max(0, reIdx - 300), reIdx + 800);
        if (!found.includes("none") && /none/i.test(surrounding) && (/关闭/i.test(surrounding) || /disable/i.test(surrounding))) {
          found.unshift("none");
        }

        if (found.length > 0) {
          results[modelId] = found;
          break;
        }
      }

      searchPos = idx + modelId.length;
    }

    // Default deepseek-v4 variants if not explicitly present in docs table
    if (!results[modelId] && modelId.startsWith("deepseek-v4") && results["deepseek-v4-flash"]) {
      results[modelId] = [...results["deepseek-v4-flash"]];
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
      Object.entries(specs).map(([model, efforts]) => ({
        Model: model,
        "Documented Efforts": efforts.join(", "),
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
