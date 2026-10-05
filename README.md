# pi-sensenova-provider

用于 [SenseNova Token Plan](https://platform.sensenova.cn/docs) 平台的 Pi provider 扩展。

直接对接平台真实接口,而不是靠猜测:

| 接口 | 用途 | pi-ai 实现 |
|---|---|---|
| `GET /v1/models` | 实时模型发现 | `fetchModels` |
| `POST /v1/responses` | OpenAI **Responses** API 对话 | 内置 `openai-responses` |
| `POST /v1/chat/completions` | OpenAI **Chat Completions** 对话 | 内置 `openai-completions` |
| `POST /v1/images/generations` | 图像生成 | 本扩展 |
| `POST /v1/images/edits` | 参考图编辑 | 本扩展 |

聊天流式处理委托给 pi-ai 内置适配器,消息转换、工具调用、推理流式、用量统计、取消与重试全部沿用 pi 的实现,不在这里重写。

## 安装

发布到 npm 之后:

```bash
pi install npm:pi-sensenova-provider
```

尚未发布时可直接从 git 安装:

```bash
pi install https://github.com/NoMoreWaiting/pi-sensenova-provider
```

从早期的 `npm:pi-sensenova` 迁移过来?先卸掉旧包——两者注册的是同一个 `sensenova` provider id:

```bash
pi remove npm:pi-sensenova
```

provider id 仍是 `sensenova`,所以 `/login sensenova`、`/sensenova-*` 命令以及 `settings.json` 里的 `sensenova/<model>` 选择器都不需要改动。

在本目录开发调试:

```bash
pi -e ./extensions/sensenova.ts
```

## 配置

```bash
export SENSENOVA_API_KEY="sk-..."
```

或者让 Pi 交互式管理凭据:

```text
/login sensenova
```

Key 会写入 `~/.pi/agent/auth.json`,`SENSENOVA_API_KEY` 作为回退。Key 在 <https://platform.sensenova.cn/console> → Management Center → API Key Management 创建。

## 模型

启动时同步注册一份种子目录,使 Pi 能立刻启动并支持离线使用;随后后台从 `/v1/models` 刷新并扩充,结果会持久化,所以新发现的模型在重启后依然存在。

种子目录(实时目录快照):

| 模型 | 类型 | API | 上下文 | 最大输出 |
|---|---|---|---:|---:|
| `sensenova-6.8-flash-lite` | chat,文本+图像输入 | responses | 262144 | 65536 |
| `deepseek-v4-flash` | chat | responses | 1048576 | 65536 |
| `deepseek-v4.1-flash` | chat | responses | 1048576 | 65536 |
| `glm-5.2` | chat | responses | 1048576 | 131072 |
| `kimi-k3` | chat | responses | 1048576 | 65536 |
| `sensenova-u1-fast` | image | images | — | — |
| `sensenova-u1.5-lite` | image | images | — | — |

平台支持 `/v1/responses` 的模型会路由到该接口,其余回退到 `/v1/chat/completions`。平台扩充该列表时,把模型加到 `extensions/sensenova.ts` 的 `RESPONSES_MODELS` 即可。

### 已在真实网关上验证的接口能力

- `store: true` 被拒绝(`store=true is not supported in stateless mode`),`previous_response_id` 也被拒绝(`pass the complete history in input`)。pi 的 Responses 适配器本来就发送 `store: false` 加完整对话历史,正好符合网关要求。
- `prompt_cache_key`、`prompt_cache_retention`、`prompt_cache_options`、`include: ["reasoning.encrypted_content"]`、工具 `strict: true`、`parallel_tool_calls`、`service_tier` 在 `/v1/responses` 上全部被接受。
- `developer` 角色在 `/v1/responses` 上可用,但在 `/v1/chat/completions` 上被拒绝,所以 completions 模型设置 `supportsDeveloperRole: false`,由 pi 折叠进 `system`。
- `reasoning.effort` 接受 `none | low | medium | high | xhigh`,`none` 返回零推理 token。`reasoning.summary: "none"` 被拒绝,因此沿用 pi 默认的 `summary: "auto"`。
- Chat Completions 接受 pi 的完整 payload 形状:`stream_options`、`store: false`、`thinking: { type }`、`reasoning_effort`、`max_tokens`。
- `text.format` JSON Schema 约束输出在 `deepseek-v4-flash`、`glm-5.2`、`kimi-k3` 上可用,但在 `sensenova-6.8-flash-lite` 上因上游 `compile_grammar_error` 失败。只有已验证的模型开启 `supportsOpenAIGrammarTools`。
- 图像编辑要求 PNG/JPEG/WebP、≤10 MB、宽高均在 256–4096 px 之间、宽高比不超过 2:1。
- Token Plan 预览期内,`/v1/models` 返回的所有模型价格均为 `0`。

## 思考等级

`reasoning: true` 取自模型的 `supported_features`,新发现的模型会自动获得该标记。pi 等级到网关参数的映射如下:

| pi 等级 | `/v1/responses` | `/v1/chat/completions` |
|---|---|---|
| off | `reasoning.effort: "none"` | `thinking: { type: "disabled" }` |
| minimal | `"low"` | `"low"` |
| low | `"low"` | `"low"` |
| medium | `"medium"` | `"medium"` |
| high | `"high"` | `"high"` |
| xhigh | `"xhigh"` | `"high"` |
| max | `"xhigh"` | `"high"` |

注意 Responses 的默认行为:未指定思考等级时,pi 会发送 `reasoning.effort: "none"`,模型不会做推理直接回答。需要在 Pi 设置里指定思考等级才会产生推理。

## 图像生成

图像输出模型注册为 `type: "image"`,因此可在 [codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md) 中通过 `models.getAvailableOfType("image")` 和 `models.generateImages()` 使用:

```javascript
const painter = await models.getModelOfType("image", "sensenova", "sensenova-u1.5-lite");
const result = await models.generateImages(painter, {
  input: [
    { type: "text", text: "A poster for a Rust workshop" },
    { type: "image", data: base64, mimeType: "image/png" }, // 可选的参考图
  ],
});
for (const block of result.output) if (block.type === "image") image(block);
```

带参考图时走 `/v1/images/edits`,纯文本提示走 `/v1/images/generations`。两者都请求 `response_format: "b64_json"`,图片以 base64 内联返回供 Pi 直接渲染。同时会额外写一份到 `.pi/generated-images/`(Pi 本身不会把生成图像落盘),保存路径以可点击链接形式报出。

## 命令

| 命令 | 说明 |
|---|---|
| `/sensenova-models [filter]` | 列出模型及其 API 路由、能力与限额。过滤器:`reasoning`、`vision`、`image`、`responses`、`tools`。 |
| `/sensenova-refresh` | 强制从 `/v1/models` 重新拉取目录。 |
| `/sensenova-usage` | 统计当前 Pi 进程中已完成的助手消息 token 与花费。 |

```text
/sensenova-models
/sensenova-models responses
/sensenova-models image
/sensenova-refresh
/sensenova-usage
```

`/sensenova-usage` 统计范围仅限本进程。本 provider 不暴露账户级统一计费接口。

## 开发

Peer 依赖(`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`)由 Pi 在运行时提供,不随包分发。

```bash
npm test                          # 26 个单元测试,不联网
npm run smoke                     # 打真实网关的端到端检查
npm pack --dry-run                # 校验打包文件清单
```

`npm run smoke` 需要 `SENSENOVA_API_KEY`,会访问真实平台,依次覆盖目录发现、Responses 对话、工具调用、推理开/关、Chat Completions 回退分支、视觉输入与图像生成,每项给出通过/失败结论。

`node_modules` 不提交。本地开发时需要 peer 依赖可解析,两种方式任选其一:

按 CI 同样的方式安装(与 Pi 的安装布局无关,最稳妥):

```bash
npm install --no-save --ignore-scripts \
  @earendil-works/pi-ai \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-tui
```

或者软链到本机 Pi 的依赖目录,省去重复下载。Pi 包自身的 `node_modules` 里带了
`@earendil-works/*`,路径可用 `pi root` 或 npm 的全局前缀推导,下面这段兼容
`pi-web` 之类的聚合包布局:

```bash
SRC=$(find "$(npm root -g)" -maxdepth 6 -type d -path "*/@earendil-works/pi-ai" \
      -not -path "*/dist/*" | head -1)
[ -n "$SRC" ] && ln -s "$(dirname "$(dirname "$SRC")")" node_modules
```

`node --test` 通过 Node 原生类型剥离直接运行 TypeScript 扩展,因此需要 Node ≥ 22.19。

## 许可证

[MIT](./LICENSE)
