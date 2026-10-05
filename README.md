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

聊天流式处理委托给 pi-ai 内置适配器,消息转换、工具调用、推理流式、用量统计与取消全部沿用 pi 的实现,不在这里重写。

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

| 模型 | 类型 | API | 上下文 | 最大输出 | 支持的思考强度 |
|---|---|---|---:|---:|---|
| `sensenova-6.8-flash-lite` | chat,文本+图像输入 | responses | 262144 | 65536 | off, low, medium, high, max |
| `deepseek-v4-flash` | chat | responses | 1048576 | 65536 | off, low, medium, high, max |
| `deepseek-v4.1-flash` | chat | responses | 1048576 | 65536 | off, low, medium, high, max |
| `deepseek-v4-pro` | chat | responses | 1048576 | 131072 | off, low, medium, high, max |
| `deepseek-flash` | chat | responses | 1048576 | 65536 | off, minimal, low, medium, high, xhigh, max |
| `glm-5.2` | chat | responses | 1048576 | 131072 | off, minimal, low, medium, high, xhigh, max |
| `kimi-k3` | chat | responses | 1048576 | 65536 | off, low, medium, high, max |
| `sensenova-u1-fast` | image | images | — | — | — |
| `sensenova-u1.5-lite` | image | images | — | — | — |

平台支持 `/v1/responses` 的模型会路由到该接口,其余回退到 `/v1/chat/completions`。所有 `sensenova|deepseek|glm|kimi` 族系对话模型已默认路由至兼容性最佳的 `/v1/responses`。

### 已在真实网关上验证的接口能力

- `store: true` 被拒绝(`store=true is not supported in stateless mode`),`previous_response_id` 也被拒绝(`pass the complete history in input`)。pi 的 Responses 适配器默认发送 `store: false` 加完整对话历史。
- 商汤网关使用严格结构体反序列化,拒绝未知字段如 `reasoning.summary`(`json: unknown field "summary"`)。Provider 自动在请求拦截层净化 `/v1/responses` 的 payload,剔除 `summary`、`encrypted_content` 与 `prompt_cache_key`。
- `developer` 角色在 `/v1/responses` 上可用,但在 `/v1/chat/completions` 上被拒绝,所以 completions 模型设置 `supportsDeveloperRole: false`,由 pi 折叠进 `system`。
- 403 权限错误(如当前 Token Plan 套餐未开通某模型)实行秒级 fast-fail。
- 关闭 Lark 语法的 Grammar Tools(`supportsOpenAIGrammarTools: false`),使用标准稳健的 JSON Schema 避免商汤分词器触发 `compile_grammar_error`。
- 图像生成与编辑自动支持 Base64 数据解码并持久化至本地 `.pi/generated-images/` 目录。
- Token Plan 预览期内,`/v1/models` 返回的所有模型价格均为 `0`。

## 思考等级

`reasoning: true` 依据模型接口元数据的 `supported_features`（包含 `"reasoning"`）自动标记，同时代码对 `sensenova|deepseek|glm|kimi` 等前缀模型做保底自动识别。

不同于粗暴的别名映射（例如把 `minimal` 映射为 `low` 或把 `max` 映射为 `xhigh`），本 Provider **严格依据商汤官方文档（https://platform.sensenova.cn/docs）和模型真实能力，为每个模型精确声明支持的档位**。不支持的档位显式设为 `null`，以便 Pi 的 `getSupportedThinkingLevels(model)` 准确向用户和交互界面展示可选列表：

| 模型 | 支持的 Pi 思考等级 | 对应商汤参数值 (`reasoning.effort`) |
|---|---|---|
| `sensenova-6.8-flash-lite` | `off`, `low`, `medium`, `high`, `max` | `none`, `low`, `medium`, `high`, `max` |
| `deepseek-v4-flash` / `pro` / `v4.1-flash` | `off`, `low`, `medium`, `high`, `max` | `none`, `low`, `medium`, `high`, `max` |
| `kimi-k3` | `off`, `low`, `medium`, `high`, `max` | `none`, `low`, `medium`, `high`, `max` |
| `glm-5.2` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (全 7 档) | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `deepseek-flash` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (全 7 档) | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

- `off` 统一对应商汤网关的 `"none"`（即关闭推理，模型不产生思考 Token 直接作答）。
- 若上游接口未来通过 `supported_reasoning_efforts` 下发档位，Provider 会优先动态提取，平滑升级。
- 支持通过 `npm run sync-docs` 自动抓取并比对商汤官网文档的最新档位定义。

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

## 已知问题

**本 Provider 不内置客户端限流器**,上游 429 直接透传给 pi,由 pi 自己的 `retry.provider.maxRetries`(默认 `0`)决定是否重试。

早期版本(commit `6ccdf6a`)在 fetch 层包了令牌桶 + 429 冷却 + 指数退避重试,实测会**阻塞 pi 的响应流**:

- 令牌桶满后请求最长排队等 `SENSENOVA_MAX_WAIT_MS`(默认 180s)才发出,期间没有错误、没有进度,pi 侧表现为"响应到一半就中断"。
- 一次 429 触发冷却升级,连打两次到 120s;若被误分类为 `FREE_QUOTA_EXHAUSTED`,直接进 10 分钟长挂起。
- fetch wrapper 包在 pi-ai 的 `options.fetch` 上,任何非致命错误都可能截断整条 stream,而 pi 看到的只是"响应中途中断"。

commit `665cfbe` 撤掉了整套机制。当前行为:

- 上游 429 由 pi 自己处理,扩展不做本地重试。
- `npm run smoke` 用 `/rps exhausted|tpm/rpm limit|RateLimitExceeded/` 识别限流,作为**警告**打印而非失败,便于观察但不阻塞主流程。

如果要在扩展内恢复限流,注意:

1. 不要前置令牌桶排队——请求先发出、让网关回答,再决定是否等待。
2. 单次等待上限 ≤ 5s,超过 pi 会感知到"响应中断"。
3. 识别并跳过 `FREE_QUOTA_EXHAUSTED` / `token plan limit exhausted`——硬配额重试无意义。
4. 冷却不要阻塞 fetch 主链路,避免并发会话互相影响。

## 开发

Peer 依赖(`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`)由 Pi 在运行时提供,不随包分发。

```bash
npm test                          # 34 个单元测试,不联网
npm run sync-docs                 # 从商汤官方文档逆向解析并校验最新思考强度规格
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
