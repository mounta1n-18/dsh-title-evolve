# title-evolve 运行逻辑与补丁清单

本文件记录插件的完整运行逻辑、所有外挂式补丁的位置与回滚方式，以及设计约束。
维护本插件前必读。

## 一、运行逻辑

### 事件流（安装即生效）

```
用户发送消息
  └─> session/event（root 宿主级事件，与官方 session-title 服务同源）
        └─> handleNewMessage(session)
              ├─ 1) 尊重手动改名：当前标题 source.kind==='user' 则跳过
              ├─ 2) 收集该会话全部人类用户消息（user/message, source.kind==='user'）
              ├─ 3) 去重：最后消息 seq 与上次处理相同则跳过
              ├─ 4) 占位：会话无标题或仍为官方 fallback 时，同步 append
              │      「标题生成中…」（source=provider/title-evolve）
              │      → 官方 ensureFallback 见到已有标题即跳过 → fallback 永不写入
              └─ 5) 异步生成：抽样 → LLM 调用 → 规范化 → append 正式标题（覆盖占位）
```

### 官方 first-prompt provider 的拦截

```
官方 provider 调度（首条消息后，request/header 就绪时）
  └─> llm/stream 瀑布（global + prepend，宿主级）
        └─> 命中：purpose==='session-title' 且 messages[0].source.plugin==='dsh-session-title-llm'
              → 返回 error-finish 流 → 官方 generateSessionTitleWithLlm 抛错
              → 官方标题永不写入（仅一条自动生成失败警告日志）
```

### 抽样与生成

- 预算 `BUDGET_BYTES = 1536`（512 汉字 × 3 字节），总量恒定，成本不随对话增长；
- 前 2 条 + 后 2 条必发（对话起点 + 最新进展），中间等距挑选，单条完整不截断；
- 必发集合超预算的罕见情况下 `fitBudget` 按序截断到剩余空间（兜底）；
- 以 `purpose: 'session-title'` 调用 `ctx.llm.stream`（DeepSeek 适配器关闭思考）；
- system prompt 要求：≤12 汉字、简洁自然、概括整个对话（不是截断成 12 字）；
- 规范化（清洗 ESC/控制符/折叠空白）后截断到 `MAX_TITLE_BYTES = 36`（12 汉字，兜底）；
- 写入 `session/title` 事件，格式与官方 provider 路径完全一致（WebUI 投影实时更新）。

### 生命周期（卸载即复原）

- `inject = ["llm", "sessionTitle", "timer"]`：patch 层插件的 apply 在 host 服务注册完成前
  就会执行（cordis 并发加载），**必须**声明 inject，否则 `ctx.get('llm')` 为 undefined、
  插件静默失效（vision-bridge 事故 #3 同款坑，曾导致本插件"动态版正常、静态版失效"）；
- 所有监听（session/event、llm/stream）注册在插件作用域，卸载/停止时自动注销；
- 会话状态存于 WeakMap（session 对象作 key），会话销毁自动回收；
- 卸载后官方 fallback / first-prompt provider 恢复工作（见下方"卸载语义"）。

### 卸载语义（重要）

- 插件已写入的标题事件保留在会话日志中（历史数据，不回滚）；
- 官方 `ensureFallback` 对"已有标题的会话"跳过写入，`first-prompt provider` 只对
  "会话尚无任何标题"的首条消息调度——因此**卸载后**：
  - 已有插件标题的旧会话：官方不会再生成（标题停留在插件最后一次生成的结果）；
  - 新建会话：官方 fallback + first-prompt 完全恢复，行为与未装插件一致；
- 即"官方复原"= 新会话行为复原；旧会话标题为插件历史成果，不视为残留副作用。

## 二、外挂补丁清单（全部改动点与回滚）

| # | 位置 | 内容 | 回滚 |
|---|---|---|---|
| 1 | `profiles/web/cordis.patch.yml` | title-evolve 插件行（含注释） | 删除该 insert 块 |
| 2 | `profiles/web/node_modules/title-evolve/` | 插件包（package.json + lib/index.js + cordis.patch.yml + README + LICENSE） | 删除整个目录 |
| 3 | `~/.dsh/title-evolve/` | 开源副本（git 仓库，与 #2 逐字节同步） | 删除目录 |
| 4 | `~/.dsh/title-evolve/scripts/check-title.mjs` | 诊断工具：解压会话日志查标题事件 | 删除文件 |
| — | 动态插件（历史） | cordis_define 版本，随进程重启自动消失 | 无需回滚 |

**纪律**：#2 与 #3 必须逐字节一致（`Copy-Item` 后校验哈希）；改代码后同步两份再重启。

## 三、设计约束与已知边界

- 拦截器依赖官方调用的 `source.plugin === 'dsh-session-title-llm'`；若 DSH 升级改变该
  标识，拦截失效（fallback 抑制不受影响）——升级后需回归验证；
- 生成失败时标题停留在占位「标题生成中…」，下一条消息重试；
- 进程重启后 WeakMap 状态清空：对"重启前已有标题"的会话，下次消息会重新生成（无害）；
- 标题仅基于用户消息（官方设计一致），assistant 输出不参与；
- 512 字预算下长会话的中间抽样条数减少，属预期取舍（成本优先）。
