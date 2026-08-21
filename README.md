# dsh-session-manager

[English](README.en.md) | 中文

一个可直接安装的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话管理插件。它列出本机全部已物化会话，包括运行中、空闲和已归档会话，并提供继续、大纲和永久删除。

## 关键说明

**不需要修改 deepseek-harness 源码。**

从 `0.2.0` 起，包内同时包含：

- 浏览器端会话管理面板；
- Host 端 `session.delete` RPC；
- 实时 Agent 停止与 Session 脱离兼容逻辑；
- JSONL 和 SQLite 持久化删除实现；
- loopback、Host、Origin 和 Fetch Metadata 安全校验。

用户只需安装本插件并重启 `dsh web`。不需要复制代码到 harness，不需要修改 `SessionsApi`、`AgentLoop`、`SessionPersistence` 或任何 harness 文件。

## 功能

- **完整会话列表**：实时、冷会话、已归档或未归档会话，按更新时间展示标题、状态、工作目录等信息。
- **继续会话**：通过浏览器 sessions 服务打开已有对话。
- **大纲预览**：在浏览器内折叠 `session.history` 尾部窗口，展示轮次、用户/助手消息数及工具调用统计。
- **永久删除**：先停止并等待目标 Agent 静默，再重新读取 live 与 durable 会话树，预检通过后删除存储数据。删除会话时会级联删除其全部 `origin: subagent` 受管子会话（最深优先）；普通 fork 自身保留，但会继续遍历其下的受管子会话。
- **多选批量删除**：列表左侧复选框中可多选，工具栏一次性删除全部选中项。仅"独立删除目标"可勾选(普通会话与孤儿受管子会话；有父会话的受管子会话随父级联删除，不单独出现)。批量删除逐个独立走完整安全删除流程，某个删除失败不会回滚已成功的，并会在确认框列出剩余失败项以便重试。
- **JSONL**：删除该会话拥有的整个目录，包括日志和同目录快照。
- **SQLite**：在当前后端连接中执行事务删除，事件行通过外键级联清理。
- **未来兼容**：若后续 harness 原生提供 `AgentLoop.stop` 或 `SessionPersistence.delete`，插件优先调用原生能力。

普通 fork 可以独立删除。`origin: subagent` 的受管子会话随仍存在的父会话级联删除：界面不提供子会话自己的删除按钮，删除父会话时确认框会提示将一并删除的子会话数量；直接对子会话发起删除请求仍返回 `agent-busy`。如果父会话已经不存在，该行会标记为孤儿并显示删除按钮，允许直接清理。删除前会先预检整棵子树，已知失败不会先删除其他成员。

## 兼容范围

- 目标版本：DeepSeek Harness `0.1.0-rc.8`。
- 已支持官方持久化后端：`session-persistence-jsonl`、`session-persistence-sqlite`。
- 自定义持久化后端必须自行提供 `delete(id)`；如果需要级联删除多个 durable 会话，还必须提供原子 `deleteMany(ids)`，否则插件会明确拒绝该级联请求，不会逐个删除造成半删。
- 删除端点仅允许 loopback authority，例如 `localhost`、`127.0.0.0/8`、`[::1]`；通过局域网地址打开页面时只显示继续和大纲。

Host 实现针对 rc.8 缺失的三处能力做兼容补齐，并使用 rc.8 的内部 lifecycle/coordinator 结构。因此升级 harness 后应先运行本仓库测试；当上游提供原生接口时，插件会优先走原生接口，减少对兼容层的依赖。

## 安装

先在插件仓库构建 tarball：

```sh
pnpm install
pnpm pack
```

再将生成的 `dsh-session-manager-0.2.2.tgz` 安装到 web profile：

```sh
dsh plugin --profile web add -w ./dsh-session-manager-0.2.2.tgz
```

安装后重启 `dsh web`。

`-w` 是必须的：profile 目录带有 `pnpm-workspace.yaml`，裸 `add` 会触发 `ERR_PNPM_ADDING_TO_ROOT`。建议发布构建后的 tarball；从 git URL 安装拿到的是源码，目标机器还需要完成构建，容易缺少 `lib/` 产物。

本包的 `dsh.bundle.patch` 自动插入一个 `dsh-session-manager` Loader 行。该行同时激活 Host 插件和 `dsh.client` 浏览器插件，peer 依赖从 dsh 应用闭包解析。安装者不需要手工编辑 profile 的 `cordis.patch.yml`。

## 使用

打开 **设置 -> 会话**：

- “继续”进入已有对话；
- “大纲”查看近期活动统计；
- “删除”打开确认框并永久删除会话。

删除不可恢复。正在打开的实时会话删除后会从 Host 注册表移除，其他界面会按现有 `host/session-removed` 生命周期更新。

## 工作原理

1. 浏览器读取 `session.list` 和 `workspace.list`，得到完整会话语料及归档状态。
2. 删除请求通过 Connection 通用 RPC caller 发送到 `/api/session.delete`。
3. 插件 Host 端先执行与 harness 相同的 loopback/同源安全检查。
4. 删除父会话时先停止父 Agent，再读取 live 与 durable 子树并停止其中的受管生命周期，防止删除窗口产生漏删。
5. 插件预检整棵删除计划；JSONL 使用可恢复暂存，SQLite 使用单事务，native backend 优先使用批量删除能力。
6. 客户端重新读取列表，确保最终展示与 Host 实际状态一致。

## 开发与验证

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

测试覆盖控制器竞态、孤儿子会话判定、loopback/Origin 拒绝、实时 lifecycle teardown、JSONL 可恢复删除、SQLite 事务删除、subagent 拒绝、普通 fork 下的级联遍历、live 子会话、失败预检和同 id 并发去重。

## 已知限制

- 大纲来自 `session.history` 的近期窗口，不是完整日志统计。
- 删除已归档会话不会清理 workspace 中过期的 `archivedSessionIds`；该条目是惰性的，不会让会话数据复活。
- `origin: subagent` 孤儿行可以在本页面直接删除；如果它下面还有受管子会话，会按同样规则级联清理。
- 会话列表没有跨标签页实时推送，页面会在删除和重连后刷新。
- 非 loopback 页面不显示删除能力。

## License

MIT
