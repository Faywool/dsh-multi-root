# dsh-multi-root

给**一个** DSH 工作区挂载**多个**仓库：额外仓库里的文件、指令与 git 状态会作为一段提示词出现在这个工作区的每个会话里，模型用一个工具就能增删这些仓库。

它只做加法。它不替换 `ctx.fs`，不替换 `ctx.sandbox`，不在 `cordis.patch.yml` 里 `disabled` 任何上游行，`inject` 是空数组，所有服务都用 `ctx.get()` 取并检查 `undefined`。**所以它坏了，坏掉的只是它自己；DSH 照常启动，会话照常打开。**

> 这是对 [`@dsh-electron/dsh-plugin-multi-root-workspace`](https://github.com/cherrchen/dsh-plugin-multi-root-workspace) 的一次重写式 fork：功能目标相同，架构相反。那个插件把 `fs-sandbox` 与 `sandbox` 两个核心 provider 换成自己的子类，任一环节不匹配就整组停摆（`agentsAtStart:3 → agentsAtEnd:0`，工作区与会话都打不开）。本插件不做任何此类替换。

## 它解决什么问题

DSH 的一个工作区只有一个根目录。你要同时改 `backend`、`web-app`、`docs` 三个仓库时，要么反复切换工作区，要么让模型记住一堆绝对路径。

装上本插件后：

- 一个工作区可以登记最多 64 个额外仓库（默认 16）
- 每个会话的系统提示里自动出现一张根表：别名、绝对路径、读写模式、git 分支与是否有未提交改动
- 模型可以用 `workspace_roots` 工具自己 `attach` / `detach` / `list`，不必你手动改配置

## 安装

从 GitHub 安装：

```sh
dsh plugin --profile desktop add github:Faywool/dsh-multi-root
```

从本地目录安装（把路径换成你 clone 的位置）：

```powershell
dsh plugin --profile desktop add D:/work/dsh-multi-root
```

或用 `file:` 链接（开发时推荐，改完重启即生效）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dsh": { "profile": { "bundles": ["…", "dsh-multi-root"] } },
  "dependencies": { "dsh-multi-root": "link:D:/work/dsh-multi-root" }
}
```

本包无 dependencies、无 peerDependencies、无构建步骤：`main` 直接指向 `src/index.js`，源码即产物。

## 用法

在新会话里直接对模型说，或自己调用工具：

```
workspace_roots(action="list")
workspace_roots(action="attach", paths=["D:/work/backend"], mode="readwrite")
workspace_roots(action="detach", alias="backend")
workspace_roots(action="import")        # 从旧版插件的遗留存储迁移
```

`action` 说明：

| action | 参数 | 作用 |
|---|---|---|
| `list` | — | 列出当前工作区已登记的根（含 id、mode、skills 状态、git 分支） |
| `attach` | `paths`（数组，必填）、`mode`、`alias`（单条时可用）、`skillsEnabled` | 新增或更新（同路径原地更新，id 不变） |
| `detach` | `target`（id / alias / 路径）或 `all: true` | 移除 |
| `rename` | `target`、`newAlias` | 改显示名（id 不变） |
| `mode` | `target`、`mode` | 在 `readwrite` / `readonly` 之间切换 |
| `skills` | `target`、`skillsEnabled` | 是否把这个仓库的技能目录暴露给模型 |
| `namespace` | `target`、`aliasId` | 改这个仓库的技能命名空间（技能显示为 `aliasId-技能名`），默认等于别名 |
| `move` | `target`、`position`（`up` / `down` / 数字） | 调整提示词与面板里的顺序 |
| `reveal` | `target` | 在系统文件管理器里打开该目录 |
| `import` | — | 读 `<DSH_HOME>/storages/multi_root_workspace.json`，导到当前工作区 |

每条根都有稳定的 `id`（UUID）：改名、改 mode、调顺序、甚至同路径重挂，id 都不变。**用 id 寻址，别名只是给人看的标签**——所以两个仓库用同一个别名时，`uniqueAlias` 会自动改成 `backend` / `backend-2`，而记录永远不会串。

`mode`：`readwrite`（默认）或 `readonly`。这只影响提示词里怎么写、以及模型被建议怎么用；**它不改变 DSH 的沙箱策略**——沙箱仍由你 profile 里的权限预设决定。

### 仓库自带的技能

仓库若在 `.claude/skills`、`.agents/skills` 或 `.dsh/skills` 下带技能（一个目录一个 `SKILL.md`），把该根的 `skillsEnabled` 打开，这些技能就会出现在模型能看到的技能列表里——读的是该仓库自己的文件，不复制、不缓存正文。技能服务缺失时这条功能静默消失，其余照常。

技能名按根加了命名空间：`api-review`、`web-review` 互不覆盖，两个仓库有同名技能也都能叫到。分隔符必须是连字符——DSH 只接受 kebab-case 的技能名（`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`），冒号之类会让她整个 provider 报 `invalid skill name` 并让本轮运行失败。每个候选还必须带 `invocation: { modelInvocable: true, userInvocable: true }`：宿主在拼技能目录时会直接读 `skill.invocation.modelInvocable`，缺了就是 `Cannot read properties of undefined (reading 'modelInvocable')`，同样整轮失败。命名空间默认等于别名，用 `namespace` 动作（或面板的「Skill Namespace」菜单项）单独改——改显示名不会连带改掉模型已经学会的技能名。

### 跨仓库找文件

```
workspace_find(query="Settings.tsx")
workspace_find(query="src/api", alias="backend")
```

按"路径相对仓库根的、大小写不敏感的子串"匹配，返回绝对路径——文件工具直接能用。默认最多 20 条，上限 60 条，扫到 4 万个条目或 2.5 秒就收手。

这就是"@ 补全覆盖额外根"的替代：DSH 0.2.2 的 `@` 只索引会话工作目录，要扩展得替换 `ctx.fs`（正是旧插件翻车的地方）。用这个工具反而不会碎。

### 跨仓库搜内容

`workspace_find` 找的是**文件名**，`workspace_grep` 找的是**文件内容**：

```
workspace_grep(pattern="IPriceBook")
workspace_grep(pattern="class ", glob="*.cs")
workspace_grep(pattern="订单", alias="PSREF_Backend")
workspace_grep(pattern="value\\s*=\\s*4\\d", regex=true, glob="*.ts")
```

- `glob` 不带路径分隔符时按**文件名**匹配、任意深度生效（`*.cs` 就是"所有 .cs"）；带分隔符时按相对路径匹配（`src/**`）
- 输出按根分组，每行 `相对路径:行号: 命中行`；`context` 可带上下一两行
- 末尾永远有一行体检报告：`scanned 27604 of 42542 visited files · 5 match(es) · 8067 ms`，被跳过时会补 `N skipped (binary)` / `N skipped (larger than 512 KiB)`，被预算或命中上限截断时补一句说明。没有这行时，"没找到"和"提前放弃"长得一模一样，模型会自信地给出错误结论
- 预算：12 秒、6 万个文件、200 条命中、单文件 512 KiB、单行 4000 字符；六个仓库全扫完约 8 秒，加 `alias` 或 `glob` 通常 200 毫秒
- **每个工作区各有开关**：弹窗里工作区下拉框右边那个「内容搜索」勾选框。关掉之后这个工作区的 `workspace_grep` 只回一句话，一个文件都不读；`workspace_find`（找文件名）不受影响

不做索引、不做语义搜索，也不替代 DSH 自带的 grep——它只是把"跨六个仓库各跑一次 grep 再人工合并"变成一次调用。

### 侧栏入口、弹窗与设置页

入口只有一个：**左栏左下角**、设置按钮那一行（上游插件放 Folders 的位置）。侧栏窄成图标栏时是一个图标，展开时是「图标 + 多仓库工作区」。点它打开一个居中弹窗——不是整页主面板，左栏顶部也不会多出菜单项：

- 图标是本插件的主图标：三层叠放的矩形（「几个仓库叠在一个工作区上」）。同一个 SVG 既画在侧栏入口上，也作为 `package.json` 的 `icon` 出现在 DSH 的插件列表里；`assets/icon.png` 是给插件商店用的位图版本（商店只收 png/jpeg/webp）
- 左下角入口的静止态用主文字色（不是次要色），鼠标移入时底色淡一层、边框变亮，图标与文字在容器里垂直居中

- 切换工作区：下拉里列的是**工作区名字**（DSH 登记的名字；没有名字时用目录名），选中后紧跟一行显示该工作区的**完整路径**，一眼能对上左栏那个工作区。根是按工作区分开保存的；打开弹窗时默认选中左侧栏当前会话所在的那个工作区——客户端把 `localStorage['dsh.sessions.current']` 里的会话 id 带在 `GET /dsh-multi-root/state?session=…` 上，宿主用 `sessions.get(id).header.cwd` 换成目录再匹配
- 每个根一行：左边是加粗的**别名**（悬停显示 id 与技能命名空间）、下面是等宽小字路径、右上角是 git 分支与脏标记、可写/只读徽章、技能开关徽章
- 重命名 / Skill Namespace 的输入框与小对话框：按钮和列表行复用同一套 `.mr-btn` 规则（描边、hover 时淡底色 + 更强边框），默认不高亮，白边不会出现
- 行右边只留两个常按的按钮「浏览」「设为只读/可写」，其余操作收进最右侧的「⋯」菜单：重命名、Skill Namespace、复制路径、启用/停用技能、在文件管理器中打开、上移、下移、移除。菜单是 fixed 定位的浮层，不会被弹窗的滚动区裁掉；点别处或按 Esc 关闭
- 「重命名」和「Skill Namespace」弹出小对话框改（输入框 + 取消/保存，Enter 提交、Esc 关闭、点遮罩关闭）——**不用 `window.prompt`**：Electron 的渲染进程不支持它，调用会被静默吞成 `undefined`，点了等于没点
- 样式全部走 DSH 自己的主题令牌（`--dsw-alias-bg-layer-1/2`、`--dsw-alias-bg-overlay`、`--dsw-alias-border-l1/l2`、`--dsw-alias-label-primary/secondary` 等），所以亮色/暗色主题下与 DSH 自带界面同一套颜色、字号和圆角
- 「添加仓库目录」直接弹系统目录选择框
- 「浏览」进入只读文件浏览：面包屑、上一层、条目列表（目录优先、跳过 `node_modules` 等）、点文件看文本预览（256 KB 截断、二进制拒读）
- 点弹窗外、按 Esc、或点「关闭」都能收起

设置 → 「多仓库工作区」里是同一张根表，外加当前生效的配置和根表文件路径。

面板的每个操作都按 `id` 发请求，所以即使你刚改过别名、或两个仓库别名很像，也不会操作错目标。

### `/multi-root` 命令

```
/multi-root list
/multi-root attach D:\work\backend
/multi-root detach backend
/multi-root alias backend api
/multi-root mode api readonly
/multi-root skills api on
/multi-root move api up
/multi-root open api
/multi-root find Settings
/multi-root dirs backend src
/multi-root search on
```

`detach` / `alias` / `mode` / `skills` / `namespace` / `move` / `open` 都接受 id、别名或绝对路径。

### 每个仓库的笔记

根表的预算里还留了一小块给「每个根自己的 `AGENTS.md`（没有就找 `CLAUDE.md`，取前 1200 字）」。所以模型不只知道"有这么个仓库"，还知道那个仓库自己的规矩。

## 配置

配置在 profile 的 `cordis.patch.yml`（设置 → 打开配置文件）：

```yaml
- insert:
    - id: dsh-multi-root
      name: dsh-multi-root
      config:
        enabled: true        # 总开关
        maxRoots: 16         # 每个工作区最多几个根，上限 64
        injectPrompt: true   # 是否把根表注入系统提示
        promptMaxChars: 4000 # 根表的字符预算，超了从尾部丢行
        showGit: true        # 是否带上 git 分支 / 脏标记
```

这些值在**使用时**读取，不是挂载时冻结的：改动保存后下一次工具调用、下一次提示词装配就生效，不需要重启。

> 设置页是客户端 UI 贡献的：DSH 0.2.2 里只有 Config schema 的 host-only 插件不会自动获得页面。本插件自带一个很小的 client 半边，把面板同时挂到侧栏和 `设置 → 多仓库工作区`，并且全程 try/catch，加载失败只是少一个面板。

## 数据放在哪

`<DSH_HOME>/storages/dsh_multi_root.json`（`DSH_HOME` 缺省为 `~/.dsh`）。按**工作区路径**分组，与 DSH 自己的 `workspace.json` 完全分开。

```json
{
  "version": 2,
  "workspaces": {
    "d:\\work\\main": {
      "path": "D:\\work\\main",
      "roots": [
        {
          "id": "8f4d690b-bce6-40ca-802b-a585dd4f21e0",
          "alias": "backend",
          "path": "D:\\work\\backend",
          "mode": "readwrite",
          "skillsEnabled": true,
          "addedAt": "2026-01-01T00:00:00.000Z"
        }
      ]
    }
  }
}
```

- 原子写（临时文件 + rename）
- 文件损坏时挪成 `.corrupt-<时间戳>` 并当空表继续
- 旧版（`version: 1`，没有 `id`）读到时会就地升级到 `version: 2` 并写回，所以 id 一次生成、长期不变
- 绝不写 DSH 自己的存储

## 三级止血

1. 配置里 `enabled: false` → 插件立刻停手，DSH 照常
2. 从 profile 的 `cordis.patch.yml` 删掉 `- id: dsh-multi-root` 这一行 → 重启后不加载
3. 从 `dsh.profile.bundles` 删掉 `dsh-multi-root` → 彻底干净

任何一步都不需要动 DSH 本体，也不会丢会话。

## 开发

```powershell
npm test     # 87 个用例，不需要装 DSH
npm run check  # 对 src 下每个文件跑 node --check（不需要构建）
```

改完 `src/client.js` 之后，**页面上刷新是没用的**。宿主按 `mtime`/`ctime`/`size` 给客户端包算一个指纹，把它写进 URL（`/plugins/??<id>/client.js&rev=<hash>`），再用 `cache-control: public, max-age=31536000, immutable` 发出去；同一个指纹就是同一份字节，浏览器会记一年。指纹只在两种情况下变：插件这行重启，或者有人调用 `ctx.clientModules.rebuilt(id)`。

这个插件默认开了 `devReload`（`DEFAULTS.devReload = true`，安装版只是多一个空转的 `fs.watch`）：它 watch 自己的客户端包，文件一变就调 `rebuilt()`，指纹和 URL 一起换新，打开的页面会拿到新代码。**它自己要先生效一次，靠的是重启应用**——改完之后重启一次 DSH，之后改 `src/client.js` 就不必再重启了。如果没生效，日志里会有：

```
[dsh-multi-root] client hot reload is watching C:\…\src\client.js
[dsh-multi-root] client bundle changed; published revision 3f9c1a2b7d40
```

看不到第一行就说明 `devReload` 没参与这次启动（`cordis.patch.yml` 的配置在 DSH 启动时读入，改它要重启应用，热重载插件不够）。

调试日志：

```powershell
$env:DSH_MULTI_ROOT_DEBUG = "1"   # 启动 DSH 后 stderr 会出现 [dsh-multi-root] … 行
```

仓库结构：

```
src/index.js     host 入口：配置、快照、六个贡献（设置/提示词/两个工具/命令/skills/路由）
src/client.js    client 半边：sidebar.footer.action、shell.overlay、settings.section
src/routes.js    HTTP 路由：state / browse / file，同源校验与路径边界
src/roots.js     纯函数：id、别名、模式、排序、容量
src/store.js     $DSH_HOME/storages/dsh_multi_root.json，原子写、损坏隔离、v1→v2 升级
src/skills.js    技能 provider，把每个根的技能以 aliasId-技能名 暴露
src/prompt.js    会话提示里的根表与仓库笔记
src/tool.js      workspace_roots 工具
src/find-tool.js workspace_find 工具
src/browse.js    只读目录/文件读取与跨根搜索
src/command.js   /multi-root 命令
src/dev-reload.js 客户端包热重载（watch + clientModules.rebuilt）
test/            87 个用例（node --test）
docs/DESIGN.md   架构、与上游的能力对照、真机踩过的坑
```

架构与设计取舍见 [docs/DESIGN.md](docs/DESIGN.md)，版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 已知限制

- **单个会话的 shell 工作目录仍然是工作区根**。本插件不改 `cwd`，只告诉模型"别的仓库在哪"，模型用绝对路径访问。
- **`@` 文件补全只覆盖会话自己的工作目录**。DSH 的 `fileReferences.list()` 按会话 cwd 限定，没有"再注册一个根"的接口。跨根查找请用 `workspace_find`。
- **Windows 上沙箱不能给进程追加可写目录**，所以 `mode: readwrite` 不会真的扩权。若你的权限预设是默认的 `workspace-write`，模型对额外仓库的写入仍会被拦；把权限预设调到能覆盖这些路径，或用本插件确认路径后再手动改。
- **这是"多根工作区"，不是"多根 sandbox"**。旧插件靠替换 `ctx.fs` / `ctx.sandbox` 做到了后者，代价是 DSH 一升级就整组塌掉；本插件不做这个交换。
- **面板里的浏览是只读的**（列表 + 文本预览），没有编辑器和 git 操作按钮；git 只显示分支与脏标记。
- **worktrees / LSP / 自动审查没有实现**。worktrees 服务会用 agent 的当前 cwd 作源仓库并"走进"新 worktree（会改会话 cwd），与本插件"不动 cwd"的前提冲突，因此暂缓。

## 为什么是 JavaScript 而不是 TypeScript

上游是 TypeScript，本插件是 ESM JavaScript + JSDoc。这是刻意的取舍，不是图省事：

| | 上游（TS） | 本插件（JS） |
|---|---|---|
| 构建 | `tsc` + `tsdown` 打包，产物在 `lib/` | 无构建，`main` 直接指向 `src/index.js` |
| 随 DSH 升级的失败面 | 编译器版本、打包器配置、产物格式、sourcemap 对齐 | 只有运行时本身 |
| `link:` 安装 | 得先 `pnpm build`，改了源码不重编就不生效 | 改完重载插件即可 |
| client 半边 | `dsh.client` + 打包成 `window.__ModuleLoader__` 工厂 | 同样手写成工厂形态（`src/client.js`），只是不经过打包器 |
| 类型安全 | 编译期 | JSDoc + `node --check`，行为由 83 个测试兜住 |

DSH 的插件加载器并不是"编译 TS 再执行"，它 `require`/`import` 的是已经可执行的 JS。上游之所以要 TS，是因为它需要跨 20 多个子路径共享类型、并且要把 client 半边打包。本插件只有一个包、一个 host 入口、一个 client 入口，多一层构建只是多一层会随 DSH 版本一起漂移的依赖。

如果以后类型真的成了瓶颈，可以加 `jsconfig.json`（`checkJs: true`）跑 `tsc --noEmit` 只做类型检查——**仍然不产出构建物**，装进 profile 的依旧是源码。

## 排错

插件自己的日志写在 `<DSH_HOME>/storages/dsh_multi_root.log`（超过 1 MB 自动清空），因为宿主 logger 在桌面端基本看不到。正常情况下每次重载一行：

```
2026-11-12T09:22:39.213Z [dsh-multi-root] registered workspace_roots through a scoped tools injection
2026-11-12T09:22:39.221Z [dsh-multi-root] registered workspace_find through a scoped tools injection
2026-11-12T09:22:39.266Z [dsh-multi-root] mounted settings, prompt, tool, workspace_find, /multi-root, panel; schema loaded; roots are stored in …
```

两个踩过的坑，写在这里省得再踩：

1. **工具必须用 `ctx.inject(['tools'], scoped => scoped.tools.register(...))` 注册。** 直接 `service(ctx, 'tools').register(...)` 看起来成功了（连重复注册都会被拒），但注册落在插件自己的 layer 里，任何 agent 都解析不到——工具列表里就是没有。
2. **`src/` 顶层不能有 `await`。** 加载器走同步 `require()`，模块图里只要有一个顶层 await 就 `ERR_REQUIRE_ASYNC_MODULE`，宿主拿不到 `Config`/`apply`，插件条目显示 `status: absent`。`test/require.test.mjs` 守这条。

界面相关的两个现象：

- **弹窗打开了但排版全乱（内容铺在左栏上、按钮挤成一行）** = 本插件的 CSS 没落地。样式用 `adoptedStyleSheets` + 自带 `<style>` 两条独立路径注入，不依赖 `styles` 服务，也不需要注册 disposer；若仍无样式，按一次 `Ctrl+R` 让新 bundle 生效。
- **左下角看不到入口** = `sidebar.footer.action` 槽被别的插件占了同一个 id，或 client bundle 没加载。前者可以改 `src/client.js` 里的 `dsh-multi-root-footer`：改成自己的 id 即可（复用官方 id 会顶掉它）。

## License

MIT。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
