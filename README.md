# pi-sensenova-provider

Pi provider extension for the [SenseNova Token Plan](https://platform.sensenova.cn/docs) platform.

Talks to the platform's real endpoints instead of guessing at them:

| Endpoint | Used for | pi-ai implementation |
|---|---|---|
| `GET /v1/models` | live model discovery | `fetchModels` |
| `POST /v1/responses` | OpenAI **Responses** API chat | built-in `openai-responses` |
| `POST /v1/chat/completions` | OpenAI **Chat Completions** chat | built-in `openai-completions` |
| `POST /v1/images/generations` | image generation | this extension |
| `POST /v1/images/edits` | reference-image editing | this extension |

Chat streaming is delegated to pi-ai's built-in adapters, so message conversion,
tool calling, reasoning streaming, usage accounting, cancellation and retries are
pi's rather than a reimplementation here.

## Install

From npm, once published:

```bash
pi install npm:pi-sensenova-provider
```

Or straight from git while it is local-only:

```bash
pi install https://github.com/NoMoreWaiting/pi-sensenova-provider
```

Coming from the earlier `npm:pi-sensenova` package? Remove it first — both
register the same `sensenova` provider id:

```bash
pi remove npm:pi-sensenova
```

The provider id stays `sensenova`, so `/login sensenova`, `/sensenova-*` commands
and the `sensenova/<model>` selectors in `settings.json` keep working unchanged.

Developing from this checkout:

```bash
pi -e ./extensions/sensenova.ts
```

## Configure

```bash
export SENSENOVA_API_KEY="sk-..."
```

or let Pi manage the credential interactively:

```text
/login sensenova
```

The key is stored in `~/.pi/agent/auth.json`; `SENSENOVA_API_KEY` is the fallback.
Keys are created at <https://platform.sensenova.cn/console> → Management Center →
API Key Management.

## Models

A seed catalog is registered synchronously so Pi starts instantly and works
offline. A background refresh replaces and extends it from `/v1/models`, and the
result is persisted so discovered models survive restarts.

Seed (snapshot of the live catalog):

| Model | Type | API | Context | Max output |
|---|---|---|---:|---:|
| `sensenova-6.8-flash-lite` | chat, text+image in | responses | 262144 | 65536 |
| `deepseek-v4-flash` | chat | responses | 1048576 | 65536 |
| `deepseek-v4.1-flash` | chat | responses | 1048576 | 65536 |
| `glm-5.2` | chat | responses | 1048576 | 131072 |
| `kimi-k3` | chat | responses | 1048576 | 65536 |
| `sensenova-u1-fast` | image | images | — | — |
| `sensenova-u1.5-lite` | image | images | — | — |

Models the platform serves on `/v1/responses` route there; anything else falls
back to `/v1/chat/completions`. Add a model to `RESPONSES_MODELS` in
`extensions/sensenova.ts` when the platform expands that list.

### Endpoint capabilities verified against the live gateway

- `store: true` is rejected (`store=true is not supported in stateless mode`) and
  `previous_response_id` is rejected (`pass the complete history in input`). pi's
  Responses adapter already sends `store: false` plus the full transcript, which
  is what the gateway wants.
- `prompt_cache_key`, `prompt_cache_retention`, `prompt_cache_options`,
  `include: ["reasoning.encrypted_content"]`, `strict: true` tools,
  `parallel_tool_calls`, `service_tier` are all accepted on `/v1/responses`.
- `developer` works as a role on `/v1/responses` but is rejected on
  `/v1/chat/completions`, so completions models set
  `supportsDeveloperRole: false` and pi folds it into `system`.
- `reasoning.effort` accepts `none | low | medium | high | xhigh`. `none` returns
  zero reasoning tokens. `reasoning.summary: "none"` is rejected, so pi's default
  `summary: "auto"` is used.
- Chat Completions accepts pi's full payload shape: `stream_options`,
  `store: false`, `thinking: { type }`, `reasoning_effort`, `max_tokens`.
- `text.format` JSON-schema constrained output works on `deepseek-v4-flash`,
  `glm-5.2` and `kimi-k3`, but fails on `sensenova-6.8-flash-lite` with an
  upstream `compile_grammar_error`. Only the verified models enable
  `supportsOpenAIGrammarTools`.
- Image edits require PNG/JPEG/WebP, ≤10 MB, 256–4096 px on each side, aspect
  ratio within 2:1.
- Pricing in `/v1/models` is reported as `0` for every model during the
  token-plan preview.

## Thinking levels

`reasoning: true` is taken from the model's `supported_features`, so newly
discovered models get it automatically. pi levels map to the gateway as follows:

| pi level | `/v1/responses` | `/v1/chat/completions` |
|---|---|---|
| off | `reasoning.effort: "none"` | `thinking: { type: "disabled" }` |
| minimal | `"low"` | `"low"` |
| low | `"low"` | `"low"` |
| medium | `"medium"` | `"medium"` |
| high | `"high"` | `"high"` |
| xhigh | `"xhigh"` | `"high"` |
| max | `"xhigh"` | `"high"` |

Note the Responses default: when no thinking level is requested, pi sends
`reasoning.effort: "none"`, so the model answers without a thinking pass. Set a
thinking level in Pi settings to get reasoning.

## Image generation

Image-output models are registered as `type: "image"`, so they are available to
`models.getAvailableOfType("image")` and `models.generateImages()` in
[codemode](../node_modules/@earendil-works/pi-coding-agent/docs/codemode.md):

```javascript
const painter = await models.getModelOfType("image", "sensenova", "sensenova-u1.5-lite");
const result = await models.generateImages(painter, {
  input: [
    { type: "text", text: "A poster for a Rust workshop" },
    { type: "image", data: base64, mimeType: "image/png" }, // optional reference
  ],
});
for (const block of result.output) if (block.type === "image") image(block);
```

Reference images route to `/v1/images/edits`; plain prompts go to
`/v1/images/generations`. Both request `response_format: "b64_json"`, so the
image block is returned inline for Pi to render. A durable copy is also written
under `.pi/generated-images/` because Pi does not persist generated images to
disk itself, and the saved path is reported as a clickable link.

## Commands

| Command | Description |
|---|---|
| `/sensenova-models [filter]` | List models with API routing, capabilities and limits. Filters: `reasoning`, `vision`, `image`, `responses`, `tools`. |
| `/sensenova-refresh` | Force a re-fetch of the catalog from `/v1/models`. |
| `/sensenova-usage` | Tokens and cost from completed assistant messages in the current Pi process. |

```text
/sensenova-models
/sensenova-models responses
/sensenova-models image
/sensenova-refresh
/sensenova-usage
```

`/sensenova-usage` is process-local. SenseNova does not expose a uniform
account-level billing endpoint through this provider.

## Develop

Peer dependencies (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`)
are supplied by Pi at runtime and are not bundled.

```bash
npm test                          # 26 unit tests, no network
npm run smoke                     # end-to-end against the live gateway
npm pack --dry-run                # verify the published file list
```

`npm run smoke` needs `SENSENOVA_API_KEY` and hits the real platform; it walks
catalog discovery, Responses chat, tool calling, thinking off/on, the Chat
Completions fallback branch, vision input and image generation, and reports each
as a pass/fail check.

`node_modules` is not committed; for local development symlink it at the Pi
installation's `node_modules` so the peer dependencies resolve:

```bash
ln -s "$(pi --version >/dev/null 2>&1 && node -p "require.resolve('@earendil-works/pi-ai')")/.." node_modules
```

`node --test` runs the TypeScript extension directly via Node's native type
stripping.
