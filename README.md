# dsh-session-manager

[English](README.en.md) | 中文

[dsh web](https://github.com/deepseek-ai/deepseek-harness) 的一个设置面板,列出**本机上的全部会话**——运行中、空闲、已归档——支持:

- **继续会话**:一键切换进入该对话并关闭设置面板。
- **预览大纲**:展示近期活动统计——轮次、用户/助手消息数、按工具分类的调用统计,以及活动窗口。
- **删除会话**:确认后永久删除任意会话。

它是唯一还能看到**已归档会话**的界面:工作区浏览器处处隐藏归档行,因此会话一旦归档,只能在这里被移除。

`dsh-plugin` topic: (https://github.com/topics/dsh-plugin)

## 功能

- **完整语料**:每个已物化会话——实时与冷会话、已归档或未归档——按最新优先排序,展示最新标题、运行/空闲状态、"未开始"标记、最后更新时间与工作目录。
- **继续**:通过浏览器 sessions 服务打开会话并关闭设置面板,直接落到对话;运行中的会话禁用该按钮。
- **大纲**:完全在浏览器中折叠 `session.history` 尾部页——不派生、不持久化任何模型可见状态。
- **删除**:主机端先停止实时会话(取消 agent、等待静默、脱离——正在打开的对话通过 `host/session-removed` 置灰),再移除持久化数据。loopback 锁定,不可恢复。

## 安装

要求 dsh 的应用闭包包含插件的 `@deepseek-ai/dsh-*` peer 包——即任何带 `@deepseek-ai/dsh-web-app` bundle 的部署。

**删除依赖 `session.delete`**——这是 dsh 近期新增的 loopback 特权 RPC。在非 loopback 页面、或宿主未暴露该方法时,删除按钮会被隐藏(若弹窗已打开则显示内联提示),仅保留"继续/大纲"。请将插件与包含 `session.delete` 的宿主版本一起发布。

```sh
# 1. 在插件目录构建并打包出 tarball(产物名为 <name>-<version>.tgz,如 dsh-session-manager-0.1.0.tgz)
pnpm install
pnpm pack

# 2. 用 tarball 安装到 profile(用 1 产出的实际文件名替换 <file>.tgz)
dsh plugin --profile web add -w ./<file>.tgz
```

> `-w` 标志是必须的:每个 profile 都带一个 `pnpm-workspace.yaml`,pnpm 会把 profile 目录当作 workspace 根,裸 `add` 会报 `ERR_PNPM_ADDING_TO_ROOT`。安装后重启 `dsh web`。

> Tarball 是构建产物(`.tgz` 在 gitignore 中),不会随仓库或 release 自动生成——发布时请用上面的 `pnpm pack` 现场生成,而不是引用一个已删除的文件。

该包是 `dsh.client` 浏览器插件,同时声明 `dsh.bundle.patch`,因此 `dsh plugin` 会将其安装为可激活的配置层,profile 的模块回退机制从 dsh 应用闭包解析其 peer 依赖。patch 插入的 loader 行使用包自身的 id(`dsh-session-manager`)——刻意不用官方的 `ui-session-manage` id,因此绝不会与已内置该行的部署冲突。本包定位为**兼容/扩展面板:仅在 dsh 未内置会话管理行时安装**。在已带官方会话管理行的当前 web-app 部署上,两个面板并存(功能相同),多出的一个是冗余的。

> 从 git URL 安装取到的是源码而非构建好的 `lib/`,且插件的 peer 包未发布到 npm,git 安装无法构建或解析它们;请改用 tarball。

## 使用

打开 dsh web 的 **设置 → 会话**。每行展示会话标题、id、徽标与元信息;操作有"继续""大纲""删除"。subagent/子会话(实时或 fork)、以及非 loopback 页面或缺少能力宿主上的删除不显示——徽标显示"由父会话管理"。

## 开发

```sh
pnpm install
pnpm build          # tsdown:产出 lib/index.js、lib/invariant.js、lib/client.js
pnpm typecheck      # tsc --noEmit 使用仅开发用的类型 stub(见下)
pnpm test           # vitest:foldOutline + controller 行为
```

构建自包含(tsdown + lightningcss),无需 monorepo 检出。`prepare` 运行同一构建,因此允许的 git 安装也会产出产物。

**干净检出的类型检查**:`@deepseek-ai/dsh-*` peer 未发布到 npm,全新安装下 `tsc` 无法解析它们。`tsconfig.typecheck.json` 引入了 `types/stubs.d.ts` 中的 ambient 声明,它们镜像本插件用到的 dsh 客户端 API 的很小片段——足以在无 peer 时检核插件自身源码。若挂载了 dsh 工作区,删除该文件让 tsc 解析真实包(参见 `src/client/*` 的 import)。

## 工作原理

- 读取 `session.list`(每个已物化会话,含已归档)与 `workspace.list` 的归档集合。
- 继续不经过 wire:调用浏览器 sessions 服务 `sessions.open`。
- 大纲读取 `session.history`(尾部页)并在客户端折叠。
- 删除写入 `session.delete`——先停止 agent、再擦除持久化数据的 loopback 特权 RPC。
- 列表与大纲采用 last-request-wins:并发读取(重连与重试竞态、连续打开大纲)不会让较慢的旧响应覆盖较新的快照。

## 已知限制

- **大纲只覆盖近期窗口,而非完整日志**——它折叠的是 `session.history` 尾部页,最多携带有限数量的消息。
- **已归档 id 可能比会话存活更久**——没有取消归档的写入,删除已归档会话会在 `archivedSessionIds` 中留下(现已过期的)id;注册表容忍缺失 id,过期条目是惰性的。
- **没有推送式语料更新**——页面在自身删除、自身打开与重连时刷新,而非响应 host 帧或跨标签页变化。
- **subagent/子会话不可在此删除**——其生命周期由父会话管理(直接删除会返回 `agent-busy`);删除入口被隐藏而非提供后被拒。
- **删除仅限 loopback 且较新**——非 loopback 页面或缺少 `session.delete` 的宿主会隐藏删除(见"安装")。

## License

MIT
