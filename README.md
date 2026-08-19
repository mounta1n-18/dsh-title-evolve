# dsh-title-evolve

DSH（DeepSeek Harness）会话标题全流程更新器 —— 解决 WebUI 标题"只反映第一次请求"的问题。

每次 DSH 回答完你的问题、进入待命状态后，本插件自动同步生成一次新的会话小标题：

- **≤12 个汉字**（36 UTF-8 字节），WebUI 标题行单行完整显示；
- **均匀覆盖整个对话过程**：只上传约 1536 字节（512 汉字）的抽样——前 2 条与后 2 条必发、中间等距挑选，**单条请求保持完整不截断**，无论对话多长，成本恒定；
- 复用当前会话的模型路由（无额外 API key、无供应商绑定）；
- 标题实时写入会话日志，WebUI 左侧会话列表即时更新。

## 效果对比

| | 默认行为 | 本插件 |
|---|---|---|
| 触发时机 | 仅第一条消息后 | 每条新用户消息后 |
| 输入 | 第一条用户消息 | 全程均匀抽样（≤512 汉字） |
| 标题长度 | 10 CJK 字符 | ≤12 汉字 |
| 覆盖范围 | 对话起点 | 整个工作流 |

## 安装

> **开机自启提示**：动态插件（方式一）随 DSH 进程重启即消失；要**每次启动自动加载**，请用方式二/方式三的静态安装。

### 方式一：动态插件（免安装，适合体验）

在 DSH 会话中让模型执行 `cordis_define`（code.host 使用本仓库 `lib/index.js` 中 `apply(ctx)` 的完整内容，插件对象为 `{ apply }`），然后 `cordis_run` 激活。进程重启后插件消失，需重新定义。

### 方式二：静态安装（dsh plugin add，开机自启）

```bash
dsh plugin add https://github.com/mounta1n-18/dsh-title-evolve
```

### 方式三：手动静态安装（开机自启，可完全离线）

1. 将本仓库复制到 profile 的插件目录：`<profile>/node_modules/title-evolve/`；
2. 在 `<profile>/cordis.patch.yml` 中加入：
   ```yaml
   - insert:
       - id: title-evolve
         name: title-evolve
   ```
3. 重启 `dsh web`，之后每次启动都会自动加载。
   回滚：删除插件目录与配置行后重启即可。

## 工作原理

> 详细运行逻辑、外挂补丁清单与回滚方式见 [ARCHITECTURE.md](ARCHITECTURE.md)。

**完全接管官方标题生成**：插件挂载期间，官方 fallback 与 first-prompt provider 均不工作；卸载后自动恢复（所有监听随插件作用域清理）。

1. **抑制官方 fallback**：监听 `session/event`（user/message，与官方 session-title 服务相同的事件源），首条消息时**同步写入占位标题「标题生成中…」**——官方 `ensureFallback` 在会话已有标题时跳过写入，fallback 从此不再出现；
2. **拦截官方 provider**：通过 `llm/stream` 瀑布拦截官方 first-prompt provider 的模型调用（`purpose='session-title'` 且 source 为 `dsh-session-title-llm` 的请求返回失败流），使其生成失败、永不写入标题；主对话与插件自身的调用不受影响；
3. **触发与生成**：每条新用户消息到达后（根会话、人类消息），抽样完整请求（前 2 条与后 2 条必发、中间等距、**单条从不截断**，≤4096 字节），以 `purpose: 'session-title'` 调用 `ctx.llm.stream`（DeepSeek 适配器关闭思考）生成标题；
4. **写入**：规范化后截断到 48 字节（15 汉字 + 1 个全角标点的余量），以 `source.kind='provider'`（provider=title-evolve）写入 `session/title` 事件，覆盖占位标题，WebUI 投影实时更新。

## 行为约定

- **挂载即接管**：官方标题生成器（fallback + first-prompt provider）在插件运行期间完全不产出标题，会话日志中不会出现官方来源的 `session/title` 事件；
- **卸载即恢复**：删除插件目录与配置行、重启后，官方机制原样恢复；
- **尊重手动改名**：你在 WebUI 手动改过的标题（source=user）不会被自动覆盖；
- **失败安全**：任何错误仅记日志，绝不重试、绝不影响主对话（生成失败时标题停留在占位文本，下轮消息重试）；
- **竞态防护**：生成期间出现新消息，过期结果自动丢弃，并续跑最新一轮；
- **零残留**：插件卸载后监听与定时器全部清理。

## 故障排查

- **静态安装后标题毫无反应（官方 fallback 照常出现）**：确认 `lib/index.js` 顶部声明了
  `export const inject = ["llm", "sessionTitle", "timer"]`。patch 层插件的 `apply` 在 host 服务
  注册完成**之前**就会执行（cordis 并发加载），漏掉 `inject` 会导致 `ctx.get('llm')` 返回
  undefined、插件静默失效——这是本插件早期"动态版正常、静态版失效"的根因（vision-bridge
  事故 #3 同款坑）。
- **如何确认插件已挂载**：WebUI「设置 → 插件」页可查看每个 loader entry 的挂载状态
  （Cordis status / 挂载失败）。
- **"左下角 cordis 运行卡片"是什么**：那是**动态插件**（`cordis_define`/`cordis_run`）的 Run
  卡片；静态插件（配置加载）正常运行时不显示任何对话流 UI，请以「设置 → 插件」页与
  标题实际更新为准。

## 成本

价格以 [DeepSeek 官方定价页](https://api-docs.deepseek.com/quick_start/pricing/) 为准。

假设日均触发 50 次标题生成（对应 50 轮对话）：
| 场景 | 单次费用 | 日均费用 | 月均费用（30天）| 
|---|---|---|---|
| 闲时 + 缓存命中 | 0.00019 元 | 0.0095 元 | ≈ 0.29 元 | 
| 闲时 + 缓存未命中 | 0.00309 元 | 0.1545 元 | ≈ 4.64 元 | 
| 高峰 + 缓存命中 | 0.00038 元 | 0.0190 元 | ≈ 0.57 元 | 
| 高峰 + 缓存未命中 | 0.00618 元 | 0.3090 元 | ≈ 9.27 元 | 

## 可调常量（lib/index.js 顶部）

| 常量 | 默认 | 含义 |
|---|---|---|
| `BUDGET_BYTES` | 1536 | 抽样输入预算（512 汉字 × 3 字节） |
| `MAX_TITLE_BYTES` | 36 | 标题上限（12 汉字，截断仅作兜底） |
| `MAX_OUTPUT_TOKENS` | 64 | 输出 token 上限 |
| `TIMEOUT_MS` | 30000 | 生成超时（超时结果丢弃） |

## 许可证

MIT
