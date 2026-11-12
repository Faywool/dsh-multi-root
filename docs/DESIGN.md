# 设计说明

这份文档解释**为什么**长成这样，而不只是它做了什么。上游 `@dsh-electron/dsh-plugin-multi-root-workspace` 的失败方式是本设计的全部前提。

## 1. 上游为什么会把 DSH 拖垮

它的 `cordis.patch.yml` 做了三件互相耦合的事：

1. `- id: fs-sandbox / disabled: true`、`- id: sandbox / disabled: true` —— 关掉上游两个核心 provider；
2. 用 `multi-root-fs` / `multi-root-sandbox` 两个子类顶替 `ctx.fs` / `ctx.sandbox`；
3. 插入 `multi-root-compat` 版本门禁，DSH 版本不在白名单里就 `throw`。

DSH 的 `ctx.shell`、`permissionPresets`、所有文件工具、sandbox-policy、terminal 都挂在 `ctx.sandbox` 上。于是：

- 门禁 throw → 两个替换 provider 不激活 → `ctx.fs` / `ctx.sandbox` 不存在 → 依赖它们的行全部 `pending (waiting for services: …)` → 整个 loader 组合塌成 0 个 agent（日志里的 `agentsAtStart:3 → agentsAtEnd:0`），工作区与会话都打不开。
- 即使版本对上了，只要上游把 `fs-sandbox` 这一行的 id 改了、或 `sandbox` 的接口变了，替换就失败，同样是全崩。

**失败模式是"要么全对，要么全崩"，而不是"功能少一点"。**

上游自己的注释（`cordis.patch.yml:39-48`）也承认这个风险：它特意不给两个替换 provider 加 inject 门禁，因为"上游已 disabled，若它们也停摆会把 `ctx.shell` / `permissionPresets` / 所有 confining tool 一起带死 = brick profile"。这是在用"不加门禁"来对冲"换心脏"，而不是消除它。

## 2. 本插件的架构契约

| 约束 | 实现 | 为什么 |
|---|---|---|
| 只做加法 | `cordis.patch.yml` 里只有一个 `- insert:` 块，一行 | 上游没有行被 `disabled`，没有 provider 被替换 |
| 零硬依赖 | `export const inject = []`；所有服务 `ctx.get(name)` + `undefined` 检查 | 缺服务只丢那一条功能，不会 `pending`、不会拖垮组合 |
| 永不 throw | `apply()` 整体 try/catch；每个贡献各自 `guard()`；Cordis `ctx.effect()` 负责清理 | 单个注册失败只回滚自己 |
| 不写官方存储 | 只写 `<DSH_HOME>/storages/dsh_multi_root.json` | 会话、工作区清单永远是 DSH 的 |
| 配置热读 | `configOf()` 每次使用时读 `resolveConfig(input)` | `.volatile()` 字段的语义是"改配置不重挂载"，所以不能在 mount 时冻结 |
| 客户端半边哑巴化 | `dsh.client` 只有一个 `{platform:'web'}`；`apply()` 里每个槽位单独 try/catch；`ctx.get('slots')` 也包 try；渲染只用已发布的槽位约定 | 槽位注册失败只是少一个面板，不是白屏；不依赖任何私有 loader 行为 |

`guard()` 的样子（`src/context.js`）：

```js
export function guard(ctx, label, register) {
  try {
    const dispose = register()
    if (typeof dispose === 'function') ctx.effect(() => dispose())
    return true
  } catch (error) {
    debug(`${label} could not be registered: ${message}`)
    report(ctx.logger, 'warn', `${label} is unavailable (${describeError(error)}); the rest of dsh-multi-root keeps working`)
    return false
  }
}
```

`apply()` 的骨架（`src/index.js`）：

```js
export function apply(ctx, input) {
  try {
    const config = resolveConfig(input)
    if (!config.enabled) { debug('disabled by configuration'); return }
    mount(ctx, () => resolveConfig(input))
  } catch (error) {
    report(ctx?.logger, 'warn', `apply() failed (${describeError(error)}); DSH keeps working`)
  }
}
```

## 3. 数据模型

按**工作区路径**分组，而不是按 workspace id，也不是按插件 Config：

```json
{
  "version": 2,
  "workspaces": {
    "d:/work/main-repo": {
      "path": "D:/work/main-repo",
      "updatedAt": 1700000000000,
      "roots": [
        {
          "id": "6f1c1f7e-0a1d-4f4b-9d2a-6c8f0d3b5e11",
          "alias": "backend",
          "aliasId": "backend",
          "path": "D:/work/backend",
          "mode": "readwrite",
          "skillsEnabled": true,
          "addedAt": "2026-11-12T09:38:12.229Z"
        }
      ]
    }
  }
}
```

`id` 是稳定身份（UUID），所有写操作按 `id → alias → 绝对路径` 命中；`alias` 只是给人看的标签，`aliasId` 是技能命名空间。版本号是 2：读到 v1 时会先补齐 `id`/`aliasId`/`skillsEnabled`/`addedAt` 再**立刻写回**，否则每次读取都会重新生成 id。

为什么是路径：工作区 id 在 `workspace.json` 里，但插件不该读它（那是官方存储）；而会话给我们的唯一稳定信息就是 `cwd`。`canonicalKey()` 统一分隔符、去尾斜杠、Windows 下小写，于是 `D:\WS` 与 `d:/ws/` 命中同一条。

所有写操作走 `RootStore` 内部的一条 promise 链串行化，避免并发 `attach` 互相覆盖。

## 4. 提示词注入点

`systemPrompt.section({ name, order, text })`，其中 `text` 是函数：

```js
text: (context) => sectionText(configOf, snapshot, context)
```

`AssembleContext.scope` 在装配时就是 agent，`directoryOf()` 从它身上解析会话 cwd，再映射到工作区与根表。选择这条缝而不是 `agent/pre-step` 事件的理由：

- 不需要在每条消息前插入合成消息，不干扰会话历史；
- 装配失败（拿不到 cwd）时返回空串即可，天然降级；
- 不依赖事件签名，事件在 DSH 版本间变化比服务方法更频繁。

上游用的是 `agent/pre-step` + `messages.toSpliced()` 的方式（`src/instructions.ts:615`），能力更强（可以在特定位置插入内容），但耦合也更深。本插件把它记作 v0.1.1 的备选。

`sectionOrder()` 取 `getSectionOrder('TOOL_SESSION_QUERY') + 1`，拿不到就回落 1000——**永远不猜一个会撞车的 order**，因为同层重名 section 会让 DSH 抛异常。

## 5. 内存镜像

提示词装配是**同步**的，而存储读取是异步的。所以 `RootSnapshot` 在启动时与每 5 秒（`REFRESH_INTERVAL_MS`）重读一次 store 建 Map；`attach` / `detach` / `import` 成功后立即 `snapshot.refresh()`，保证下一次装配看到新值。git 状态单独走 `GitStatusCache`（TTL 5 秒），`peek()` 同步取，避免装配期阻塞。

`setInterval` 会 `unref()`，并通过 `ctx.effect()` 在插件卸载时清掉，不会拖住进程退出。

## 6. 与上游的能力对照

| 能力 | 上游 | 本插件 |
|---|---|---|
| 一个工作区多个根 | ✅ | ✅ |
| 提示词注入根表 | ✅ | ✅ |
| 模型自助增删根 | ✅（命令） | ✅（工具 + `/multi-root`） |
| 每根读写模式 | ✅ | ✅（仅提示词层面） |
| 从旧存储迁移 | ❌ | ✅ `action: import` |
| 每个根的 `AGENTS.md` 摘要 | ✅ | ✅（提示词附录，1200 字/根） |
| 侧栏左下角入口 + 弹窗 | ✅ | ✅（`sidebar.footer.action` + `shell.overlay`） |
| 设置页 | ✅ | ✅（`settings.section`，配置表只读展示） |
| 文件浏览 | ✅（文件树 factory） | ✅（面板内只读浏览 + 文本预览） |
| 跨根查找（替代 `@`） | ✅（替换 `ctx.fs`） | ✅ `workspace_find` |
| 替换 `ctx.fs` / `ctx.sandbox` | ✅ | ❌（故意的） |
| 版本门禁 throw | ✅ | ❌（故意的） |
| 稳定记录 id（改名/换序/重挂不变） | ✅ | ✅ |
| 仓库自带 skills（`.claude/skills` 等） | ✅ | ✅（借 `ctx.skills` 的 provider，不替换；`aliasId-技能名` 分根命名（kebab-case 是硬约束）） |
| 每根可改的技能命名空间 | ✅（`setAliasId`） | ✅（`action: namespace` / `/multi-root namespace` / 面板按钮） |
| 弹窗式管理（不占左栏顶部、不占整页） | ✅ | ✅（`shell.overlay`；刻意不注册 `sidebar.panellist` 与 `main`） |
| worktree 管理 | ✅ | ❌（会改会话 cwd，与前提冲突） |
| LSP、进程围栏、自动评审 | ✅ | ❌ |

少掉的部分都不是"忘了做"，而是每一样都要碰核心栈或前端契约。**要先把"绝不拖垮 DSH"这条做到可验证，再谈能力。**

## 7. client 半边

DSH 0.2.2 不要求客户端插件有构建产物：`package.json` 里 `exports["./client"]` 指向的模块由宿主以 `window.__ModuleLoader__.load({ id, factory })` 的形态加载，工厂里只能 `require("react")` / `require("react-dom")`，`apply(ctx)` 里通过 `ctx.slots` 注册。

本插件据此手写 `src/client.js`（不经过打包器）：

| 槽位 | 用途 | 关键约束 |
|---|---|---|
| `sidebar.footer.action` | 左栏左下角入口（设置按钮那一行） | ownerProps 是 `{wide}`；窄栏渲染纯图标，宽栏渲染「图标 + 文字」 |
| `shell.overlay` | 居中弹窗 | 该层默认 `pointer-events:none`，遮罩自己 opt-in；关闭时渲染 `null` |
| `settings.section` | 设置页分节 | 复用同一个 `Manager` 组件 |
| `settings.section.icon` | 设置页图标 | 同上 |

弹窗的开合状态存在 bundle 模块级的小 store 里（`dialog` + `subscribe` / `setDialogOpen`），因为入口按钮和弹窗分属两棵组件树。刻意**不注册** `sidebar.panellist`（左栏顶部图标）与 `main`（整页主面板）：上游是弹窗，整页会顶掉会话。

工作区选择器的显示值是**名字**、值是**路径**：`workspaceName(item)` 先取 `workspaceRegistry` 给的 `title`，没有就取路径最后一段；选中后紧跟在工具栏下面渲染一行 `.mr-ws-path` 显示完整路径（等宽小字、可换行），所以两个同名工作区也不会认错，而 `<option>` 的 `title` 属性同时挂着完整路径供悬停查看。切工作区只是改查询条件——根表本身按工作区路径分组，切过去自然是那一套。

样式只用 DSH 已发布的主题令牌（`client/Theme/listTokens` 里那 14 个 `--dsw-alias-*` 加 `--dsw-specific-sidebar-fill`），全部带 fallback；早先自造的 `--dsw-text-primary` / `--dsw-surface` / `--dsw-border` 并不存在，等于一直在吃 fallback，所以看起来"不像 DSH"。常用映射：弹窗 `bg-layer-1`、浮层 `bg-overlay`、弱边框 `border-l1`、强边框 `border-l2`、主文字 `label-primary`、次文字 `label-secondary`、错误 `state-error-primary`。

根表每行两段：左半 `.mr-main`（加粗别名 + 徽章 + git 在上、等宽路径在下），右半 `.mr-actions`（浏览、可写/只读切换、以及最右侧的 `⋯`）。次要操作全部收进 `⋯` 菜单：重命名、Skill Namespace、复制路径、启用/停用技能、在文件管理器中打开、上移、下移、移除。菜单用 `position:fixed` + 点击时 `getBoundingClientRect()` 算出的 `right/top`（或 `bottom`）渲染——绝对定位会被 `.mr-dialog-body{overflow:auto}` 裁掉，这是实测出来的（`.mr-list` 的 `overflow:hidden` 也一样会裁）。

**改别名与改命名空间不能用 `window.prompt`。** Electron 渲染进程不支持它：调用不会弹框，而是抛错或返回 `undefined`，原来的代码把它包在 try 里，于是"点了没反应"。现在改成列表下方的一行内联编辑（`.mr-edit`：标签 + 输入框 + 保存/取消，Enter 提交、Esc 取消），提交成功才收起，失败把服务端的 `error` 原样显示在 `.mr-edit-error`。

**弹窗要跟着左侧栏当前会话走。** 客户端没有"当前工作区"的 API（`workspaces` 服务只有 create/rename/delete/archive，没有 list store；`sidebar.footer.action` 只收到 `{wide}`；也没有任何"选中会话"客户端事件）。可靠链路是：客户端读它自己持久化的 `localStorage['dsh.sessions.current']` 拿 session id → 请求 `GET /dsh-multi-root/state?session=<id>` → 宿主 `sessions.get(id).header.cwd` 换成目录 → 与 `workspaceRegistry.list()` 的路径做 `canonicalKey` 等值/前缀匹配，返回 `current`。客户端 `pickWorkspace()` 的优先级是：手动选的 → `current` → 第一个。CLI 调用方没有 session 参数时，宿主退回"最近一次会话事件记下的目录"。

数据不经过 typert 代码生成，而是宿主 `src/routes.js` 自己注册的 HTTP 路由：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/dsh-multi-root/state` | GET / POST | 读全部工作区（`workspaceRegistry.list()` 与根表并集，空工作区也列）与 git；写 `attach` / `detach` / `mode` / `alias` / `skills` / `namespace` / `move` / `reveal`，一律按 `id` 寻址 |
| `/dsh-multi-root/browse` | GET | 列某个**已登记根**下的一层目录 |
| `/dsh-multi-root/file` | GET | 读某个已登记根里的文本文件（256 KB 截断、二进制拒读） |

跨源 POST 一律 403，比较的是 `webServer.getOrigin()`；路径逃逸（`..`）由 `resolveInside()` 用 `path.relative()` 判边界，只允许落在已登记根内部。

client 侧的 fail-soft 与 host 侧同构：`ctx.get('slots')` 包在 try 里、每个槽位单独 try/catch、`pickDirectory()` 缺失时提示手输路径。任何一个槽位注册失败，只丢那个入口。

## 8. 五条用真机换来的教训

**① 工具必须走 scoped inject。** `service(ctx, 'tools').register(def)` 看起来完全成功：返回 disposer、重复注册还会被拒（`tool "workspace_roots" is already registered`），但注册落在插件自己的 layer 里，`tools.view(undefined).knownNames` 里没有它，任何 agent 都解析不到。正确写法是 `ctx.inject(['tools'], scoped => scoped.tools.register(def))`——这也是 windows-mcp 等第三方插件的写法。诊断时不要只看 `register()` 有没有抛，要看"下一步的 agent 工具列表里有没有它"。

**② `src/` 顶层不能有 `await`。** 加载器走同步 `require()`；`src/config.js` 曾经用 `await import('@deepseek-ai/schemastery')` 做可选解析，结果整个模块图变成含 TLA 的 ESM，报 `ERR_REQUIRE_ASYNC_MODULE`，宿主拿不到 `Config`/`apply`，`Config/listConfigs` 里显示 `status: absent`。现在改成 `createRequire` 三锚点同步解析（`import.meta.url` → profile `package.json` → 打包的 asar 内路径），全部失败就退回 `Config === undefined`。`test/require.test.mjs` 守两条：CJS `require` 能加载本包、顶层没有裸 `await`。

**③ `apply()` 可能早于服务就绪，一次性 `ctx.get()` 会永久丢功能。** 一次重启后日志是 `settings form could not be registered: the settings service is not mounted` / 两个工具的同类行，只剩 `mounted prompt, skills`，并且 `/dsh-multi-root/state` 直接 404。原因：本行没有 `inject`（这是故意的，避免 pending 拖垮组合），所以 `apply()` 跑在 services 之前，而当时每处都只读一次 `ctx.get()`。改法是 `withService(ctx, name, label, run)`——有 `ctx.inject` 就等它出现再注册，没有就退回一次性读取（测试里的 fake ctx 走这条）。仍是 fail-soft：等不到只是少一个功能。

**④ 样式必须自己保管，不能只交给 `styles` 服务。** 弹窗第一次上线时整页是"无样式"的：内容直接铺在左栏上，行没有网格、按钮挤成一行。`ctx.get('styles').insert(STYLE)` 返回的 disposer 被 `ctx.effect` 接管，热重载后旧 fiber 销毁会把这份 CSS 一起撤走，而新实例不一定再落一份；此外该服务把规则限定在调用它的那个 frame 里，`shell.overlay` 渲染在 shell 浮层，未必落在作用域内。现在 `insertStyles()` 走两条独立路径：`new CSSStyleSheet()` + `document.adoptedStyleSheets`（不受 inline-style CSP 限制）**和** 一个模块级 `styleElement` 挂在 `<head>`，两条路径都不注册 disposer——样式宁可多活一份，也不能在重载后消失。

**⑤ skill provider 返回的名字必须是 kebab-case，且每个候选要带 `invocation`。** `@deepseek-ai/dsh-skill` 用 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` 校验候选名，一个不合格就让**整轮运行**失败（`skill provider "dsh-multi-root" returned invalid skill name "web-backend:api-test"`），而不是只忽略那个技能。所以命名空间分隔符只能用 `-`，并且两段（aliasId 与目录名）都要过一遍 `kebab()`。修完名字还会撞上第二道门：宿主拼技能目录时直接读 `skill.invocation.modelInvocable`（`skills.map(skill => ({ …, modelInvocable: skill.invocation.modelInvocable }))`），候选缺 `invocation` 就是 `Cannot read properties of undefined (reading 'modelInvocable')`，同样整轮失败——所以 `list()` 的候选和 `get()` 的 `SkillDefinition` 都要带 `invocation: { modelInvocable: true, userInvocable: true }`（`SkillSummary` 的类型里这个字段是必需的）。容器一旦报这类错，用户看到的是"发 Prompt 直接失败"，比面板里的任何问题都刺眼——这也是"插件坏了不能影响 DSH"这条约束的直接体现：一个字段漏了，整个 provider 连坐。

## 9. 验证手段

- `node --test`：**83 个用例**（roots 8 / store 6 / prompt 8 / tool 18 / apply 9 / routes 17 / client 6 / require 2 / id 9），覆盖改名去重、id 稳定性、预算裁剪、损坏恢复、并发写、注册失败隔离、路由鉴权与路径逃逸、client 半边四个槽位的注册与渲染。不需要装 DSH 就能跑。
- probe profile：复制 profile、junction 出 node_modules、只加本插件，起真实实例确认 `apply() reached` 与 `mounted …`，且宿主正常监听端口。
- `--dump-config`：确认补丁行被 loader 接受，且组合树里只有我们这一行新增。
- 真机：`GET /dsh-multi-root/state` 返回 200 与 6 个根；`cordis_inspect_query` 的 `Slots/listSubTree` 里 `sidebar.footer.action` / `shell.overlay` / `settings.section` 的 occupants 都有本插件且 `active: true`；`workspace_roots` / `workspace_find` 出现在模型工具列表里并能真实 attach → list → find → detach。

## 10. 还没做的

- worktree 管理：`worktrees.create()` 用 agent 当前 cwd 作源仓库并会把会话"走进"新 worktree，与本插件不动 cwd 的前提冲突；要做得先解决"多仓库同时开 worktree"的会话归属问题。
- LSP、skills 同步、进程围栏、自动评审：都要包裹核心服务（`ctx.subprocess`、`ctx.shell`、`lsp`），和上游同样的风险面。
- 面板里的编辑与 git 操作：目前只读预览，避免把前端变成第二套文件工具。

