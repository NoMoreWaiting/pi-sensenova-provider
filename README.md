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

聊天流式处理委托给 pi-ai 内置适配器,消息转换、工具调用、推理流式、用量统计与取消全部沿用 pi 的实现,不在这里重写。429 限速与重试例外,见[限流与重试](#限流与重试)。

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

## 限流与重试

SenseNova 网关对**每个模型**和**每个端点**分别限流,实测同一时刻并发请求会直接报 429:

```json
{"error":{"message":"rps exhausted","type":"quota_exceeded_error","code":"8"}}
{"error":{"message":"inference exceeds tpm/rpm limit","type":"rate_limit_error",
  "code":"RateLimitExceeded.EndpointTPMExceeded"}}
```

网关**不返回 `Retry-After` 头**,客户端没有任何可以参照的服务端信号,只能在本地限流。

另一个坑:同样是 429,含义完全不同:

| 情况 | 表现 | 策略 |
|---|---|---|
| 瞬时速率超限 | `RateLimitExceeded.*`、`rps exhausted`、`inference exceeds tpm/rpm limit` | 退避重试 |
| 免费额度用尽 | `FREE_QUOTA_EXHAUSTED`、`quota exhausted`、`token plan limit exhausted` | **绝不重试**,长冷却挂起 |
| 模型未在该 Token Plan 授权 | `403 model is not available in the current token plan` | 立刻失败 |

前两者共用 429,但前者等一会儿能好,后者等多久都没用——免费额度是**每模型 5 小时滑动窗口**共 1500 次调用,窗口内没有恢复手段。混淆这两者会把重试预算全花在永远不会成功的请求上。

### 实现

在 fetch 层包了一层(注入 pi-ai 的 `options.fetch`,聊天与图像两个路径都覆盖):

1. **令牌桶前置限速**。每个模型一个桶,`SENSENOVA_RPM` 控制填充速率,`SENSENOVA_BURST` 控制突发额度。请求在发出前先取令牌,取不到就排队,把速率压在线额之下而不是撞上去。
2. **429 冷却挂起**。收到 429 给该模型记一个冷却期,后续所有请求排队等它过去;连续触发时按 2 倍递增,封顶 `SENSENOVA_COOLDOWN_MAX_MS`。这是防止 429 风暴的关键——第一个请求被限之后,不是所有并发请求一起重试,而是一起等。
3. **有限重试**。仅对瞬时 429/5xx 重试 `SENSENOVA_MAX_RETRIES` 次,指数退避加抖动,并尊重服务端 `Retry-After`(如果以后开始返回)。重试前至少要等冷却期结束,避免立刻打回去。
4. **额度用尽时不重试**,改为挂起 10 分钟,让 pi 上层的重试也不会去轰一个无法恢复的端点。

限流器会**原样回传 HTTP 状态码和错误正文**(而不是抛一个被 SDK 折叠成 `Connection error.` 的异常),所以 pi-ai 能按常规格式报告 `Provider error (429): ...`,报错信息不丢。

### 实测

5 个并发请求打到 `sensenova-6.8-flash-lite`,`SENSENOVA_RPM=20`、`SENSENOVA_BURST=2`:

```text
req0 queued  0ms     → HTTP 200
req1 queued  0ms     → HTTP 200        ← 突发额度
req2 queued  1ms     → HTTP 200        ← 排队 3.3s 后发出
req3 queued  1ms     → HTTP 200        ← 排队 6.7s 后发出
req4 queued  1ms     → HTTP 200        ← 排队 9.9s 后发出

throttled=0 retried=0 waited=17991ms
```

没有一次 429,请求按 3 秒间隔平滑发出,而不是 5 个同时撞上去。

### 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SENSENOVA_RATE_LIMIT` | `1` | 关闭限流(不推荐,会重新出现 429 风暴) |
| `SENSENOVA_RPM` | `20` | 每个模型的每分钟请求数 |
| `SENSENOVA_BURST` | `2` | 突发额度,取整秒内可同时发出的请求数 |
| `SENSENOVA_MAX_RETRIES` | `2` | 瞬时 429/5xx 的最大重试次数 |
| `SENSENOVA_BACKOFF_BASE_MS` | `1500` | 退避起始间隔 |
| `SENSENOVA_BACKOFF_MAX_MS` | `30000` | 退避上限 |
| `SENSENOVA_COOLDOWN_BASE_MS` | `15000` | 首次 429 的冷却期 |
| `SENSENOVA_COOLDOWN_MAX_MS` | `120000` | 冷却期上限,连续触发时 2 倍递增 |
| `SENSENOVA_MAX_WAIT_MS` | `180000` | 排队取令牌的最长等待,超时后照发让网关回答 |

`/sensenova-throttle` 可随时查看每个模型的实际状态(请求数、被限次数、重试次数、当前冷却期、累计排队时长),`/sensenova-throttle reset` 清掉全部冷却。

这与 pi 自身的 `retry.provider.maxRetries`(默认 `0`)是**正交**的两层:这里做的是本地限速与单次请求内重试;pi 那层是代理级别的重试。本扩展只重试瞬时限速、对额度用尽立刻失败,符合 pi 官方"除非确有需要否则保持 `retry.provider.maxRetries` 为 0"的建议。

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
| `/sensenova-throttle [reset]` | 查看各模型限流器状态(请求/被限/重试/冷却/排队时长);`reset` 清空全部冷却。 |

```text
/sensenova-models
/sensenova-models responses
/sensenova-models image
/sensenova-refresh
/sensenova-usage
/sensenova-throttle
/sensenova-throttle reset
```

`/sensenova-usage` 统计范围仅限本进程。本 provider 不暴露账户级统一计费接口。

## 开发

Peer 依赖(`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`)由 Pi 在运行时提供,不随包分发。

```bash
npm test                          # 43 个单元测试,不联网
npm run smoke                     # 打真实网关的端到端检查
npm run demo:ratelimit            # 演示限流器如何平抑并发突发
npm pack --dry-run                # 校验打包文件清单
```

`npm run smoke` 需要 `SENSENOVA_API_KEY`,会访问真实平台,依次覆盖目录发现、Responses 对话、工具调用、推理开/关、Chat Completions 回退分支、视觉输入与图像生成,每项给出通过/失败结论。

`npm run demo:ratelimit` 向真实网关发并发请求并打印每个请求的排队与结算时间、429 状态分布和限流器快照,用于验证限流参数是否符合预期:

```bash
SENSENOVA_API_KEY=sk-... SENSENOVA_RPM=20 SENSENOVA_BURST=2 LIVE_CONCURRENCY=8 npm run demo:ratelimit
LIVE_MODEL=sensenova-6.8-flash-lite npm run demo:ratelimit
```

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
