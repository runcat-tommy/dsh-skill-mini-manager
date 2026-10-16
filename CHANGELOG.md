# CHANGELOG

## [2.0.3] - 2026-10-16

### 修复

- **修复「一个预设的 skill 都读不出来」——DSH 0.2 换掉了取 scope 的方法。** 0.2 起
  `AgentPresets.standingKeyFor(id)` **被直接删除**，取而代之的是 `acquireScope(id)`，
  而它**不是改名**：返回的是一个**租约**（`{ key } & AsyncDisposable`），读完该 scope
  必须 `dispose`，否则那份预设修订会被 `retain` 一直留在内存里。1.0.1 用的是旧名字，
  于是在 0.2 宿主（含桌面端 0.2.0-rc.2）上**每个预设都抛**
  `presets.standingKeyFor is not a function`，页面上 4 个预设全部报错、一个 skill 都列不出来。
  - 现在两代 API 都支持：有 `acquireScope` 就用它并**在 `finally` 里释放租约**（读取抛错也释放），
    只有 `standingKeyFor` 的 0.1.x 宿主走旧路径（无需释放）；两者都没有时给出**点名两者的**明确报错，
    而不是抛 `undefined is not a function`。
  - 这正是本次 peer 声明所承诺的范围 `^0.1.0-rc.6 || ^0.2.0-rc.1`：**声明了 0.2.x 就得真的能在 0.2.x 上跑。**
  - 教训：**这个 bug 是测试放过去的**——`test/host.test.mjs` 的假 roster 只实现了旧方法，
    所以 64 项测试全绿而真机全红。本次补了 5 个用例：0.2 路径能读出预设层、租约在读完/抛错时都被释放、
    两代同时存在时优先 0.2、两代都没有时报错可读、0.1 旧路径仍可用。
- **补上宿主版本要求（peer 声明）**：本包此前没有 `peerDependencies`，社区市场只能把它判为 `unknown`。市场只认三类声明——`engines.dsh`，以及 `peerDependencies` 里既在**宿主包清单**内、又匹配 `@deepseek-ai/dsh*` 的项（`dshmarket/lib/discovery-compatibility.js` 的 `deriveHostCompatibility`）；一条都没有，插件就无法声明「我支持 0.2.x」。
  - 现补 3 条，正是 `dsh.client.inject` 已声明的三个包：`@deepseek-ai/dsh-client-runtime` / `dsh-client-locale` / `dsh-client-ui-settings`，范围统一为 **`^0.1.0-rc.6 || ^0.2.0-rc.1`**。
  - 为什么是两段式：只写 `^0.2.0-rc.1` 会把仍在 0.1.x 宿主上的用户判成 `incompatible`；两段式同时覆盖 `0.1.0-rc.6` / `0.1.0-rc.8` / `0.1.1-rc.2` / `0.2.0-rc.2` / `0.2.1-alpha.4`。**日后两条线若不可兼得，以 0.2.x 为准，放弃 0.1.x。**
  - ⚠️ **实测补充（2026-10-16，直接跑 dshmarket 自己的 `corePackageNames` + `deriveHostCompatibility`）**：判定**随部署布局而变**，因为市场只统计「宿主 `node_modules/@deepseek-ai` 下、名字以 `dsh`/`cordis` 开头的目录」。
    - **桌面端**：宿主装包在 `app.asar` 里（`dsh/node_modules/@deepseek-ai/*`），清单 285 个名字 → `dsh-client-locale` 与 `dsh-client-ui-settings` **在列**，`dsh-client-runtime` **不在**（它只以 `@deepseek-ai/.dsh-5pHextoZ/…` 这种暂存形态存在于 CLI 安装里）→ **计 2 条，判 `compatible`**。
    - **CLI 安装**：包被嵌套在 `dsh/node_modules/` 下，宿主 `@deepseek-ai` 根目录里只有 `dsh` 一个目录 → 三条 peer **一条都不计**，仍是 `unknown`。所以 CLI 用户看到 `unknown` 属正常，**别据此以为坏了**。
    - `dsh-client-runtime` 这一条在这两种布局下都**不计入**，属冗余声明（三个包在 npm 上都真实存在，故不会造成安装报错）。

### 说明

- `lib/index.js` 除 `VERSION` 外**另有实质改动**（见上：`acquireView` / `releaseView` / `withViewSlots`，
  以及两个调用点改为在租约内读取）。`lib/client.js` 与 `lib/catalog.js` 未改。
- `test/release.test.mjs` 的「CHANGELOG 日期成对」用例把 `2.0.3` 加进版本清单，本次两文件都必须带日期条目。
- 实测证据：宿主 `0.2.0-rc.2`（桌面端与 CLI 一致）。① 真机方法面：`dsh-agent-preset-registry`
  的 prototype 上 `acquireScope` 是 function、`standingKeyFor` 是 `undefined`，本插件现在走 0.2 分支；
  ② peer 判定用 dshmarket 自己的函数跑出 `unknown` → `compatible`（桌面布局）；③ **69 项单测全绿**。

### 发布

- npm：`dsh-skill-mini-manager@2.0.3`
- GitHub：https://github.com/runcat-tommy/dsh-skill-mini-manager

## [2.0.2] - 2026-10-13

**纯文档版本**，存在的唯一目的：把 2.0.1 之后仓库里的安装说明同步到 npm 页面。
npm 只渲染**发布那一刻**的 `README.md`，所以文档改了不重发，npm 页面上就永远是旧的。

### 文档

- 安装章节补上**不用 `git` 的下载安装路径**（Code → Download ZIP → 解压后 `add`），
  并提醒解压目录带 `-main` 后缀。原来第 ③ 条只写了 `git clone`，等于把本机没装 `git` 的人挡在门外。
- 三条路各补「适合谁」，表格加了这一列，并加一句总结（能装 npm 就装 npm）。
- 测试新增断言：两份 README 都必须给出 Download ZIP 这条路。

### 说明

- **代码零改动**：`lib/` 下的三个文件与 2.0.1 逐字节相同，只是 `VERSION` 常量跟着升了一位。
- npm 页面照旧渲染英文 README（本包 2.0.1 起沿用「英文在前」的约定）。

## [2.0.1] - 2026-10-13

**首个发布到 npm 的版本。** `1.0.x` 只在 GitHub 上存在过，从未发布到 npmjs，
所以这是 npm 上的 0 号版本；版本号直接落在 `2.0.1` 是刻意的选择，不代表存在破坏性变更。

### 发布

- 发布到 npmjs：<https://www.npmjs.com/package/dsh-skill-mini-manager>
- README 安装章节按三条路写全（GitHub 直装 / 下载到本地 / npm），并附对照表：
  三条路的**构建审批**与**更新方式**不同，只给一条命令会让人踩坑。
- npm 页面渲染英文 `README`（本包首次发布，沿用本仓库多数插件与最近两次发布的约定）。

### 说明

- 本插件**没有构建步骤**：`lib/client.js` 是手写的 `__ModuleLoader__` bundle 且已提交进仓库，
  `package.json` 里也没有 `prepare` 脚本。所以三条路都不需要「先构建」，
  GitHub 直装通常也不会触发构建审批。

## [1.0.1] - 2026-10-13

### 修复

- **修复「一个 skill 都显示不出来」。** 首个版本只读了 `ctx.skills` 的**全局层**，
  而 DSH 的 skill 注册表是 host + 按 scope 分层的，并且 `dsh-web-app` 的补丁
  **显式禁用了宿主机上的 `skill-filesystem` 行**（注释原文：「presets own local
  discovery」）。结果是：标准 web profile 上全局层**本来就是空的**，所有用户 skill
  都在**各个 agent 预设的层**里——只读全局层必然得到空目录，而这恰好是最需要有内容的
  那些部署。现在改为逐个读取「全局层 + roster 里每个预设的层」再按名称合并，
  预设的读取走 `AgentPresets.standingKeyFor(id)`（DSH 为无 agent 的宿主读取者提供的
  读取 scope）。
- 列表新增「**提供给**」标记，标出每个 skill 由哪些预设（或全局层）提供给 agent；
  预设自带 `skills/` 目录的私有 skill 只标该预设。
- 读不通的预设（组合文件损坏、standing mount 失败、roster 整体读不了）会**明确报在页面上**，
  而不是静默地少列几个 skill；roster 完全不可用时退化为只读全局层。
- 新增拒绝原因 `ambiguous`：同名 skill 在不同预设层里指向不同文件时，页面列出它但不提供移除
  （浏览器只发名称，没有唯一目标就不猜）。
- 测试从 42 个增至 **51 个**，新增的 9 个是针对上面这个「空目录」bug 的回归测试。

### 发布

- 首次发布到 GitHub：<https://github.com/runcat-tommy/dsh-skill-mini-manager>
- `package.json` 补上 `repository` / `homepage` / `bugs`。
- README 安装章节补上「从 GitHub 直接装」与「从本地目录装」两条路（含更新与卸载）。
- 新增 `screenshots.json` 与 `assets/preview-zh.jpg` / `assets/preview-en.jpg` 两张 UI 预览图。
  `screenshots.json` 是市场详情页预览图的**确定性来源**——不声明就只能回退到从 README 抽图，
  而那套启发式会丢掉 svg、只认 4 个 GitHub 图床、还要求语义分 ≥ 20，实测全市场只有 18% 的条目有预览。
  两份 README 各放**与本文件语言一致**的那一张，`screenshots.json` 则两张都留（市场不分语言）。

## [1.0.0] - 2026-10-13

首个版本。

### 功能

- 在 DSH Web 设置的 `settings.section` 里注册独立一页 —— id `skill-mini-manager`，
  order `16`，与内置「插件」分区（order `15`）**同级**，而不是它里面的标签页。
- 列出当前 DSH 装的全部 skill：名称、**skill 自己的简介**（`description`）、
  可选的 `whenToUse`、来源、模型/用户可调用面、目录路径、文件数与字节数。
- 目录按名称 / 简介 / 使用时机过滤，带刷新与计数。
- 逐个移除 skill：二次确认并显示将要移动的确切路径；移除是**移入回收站**而不是删除，
  回收站可恢复，也可显式清空（清空同样二次确认）。
- 中英双语文案，跟随 DSH 界面语言。

### 安全约束

- 浏览器只发 skill 名称或回收站条目 id，**从不发路径**；宿主每次用自己的规则重新解析目标。
- 拒绝移除：`bundled` 来源、`runtime` provider、`.system` 目录内、无文件路径、
  不在已知 skill 根目录内、不支持的布局、`SKILL.md` 丢失。
- 移除目标永远不会是 skill 根目录本身。
- 回收站的恢复与清空只作用于本插件自己写出的条目（严格校验收站目录名）。
- 四条 HTTP 路由只接受同源请求；请求体上限 64 KiB。
- 单条 skill 的统计最多扫描 5000 个文件，超出即标记截断而不是继续遍历。

### 装箱内容

- `lib/index.js`：宿主半侧（四条路由 + 回收站 + 拒绝规则）。
- `lib/catalog.js`：纯函数核心，可脱离 Cordis 与文件系统测试。
- `lib/client.js`：手写 `__ModuleLoader__` bundle，无构建步骤，只依赖 `react` 平台种子。
- `test/`：42 个测试，全部通过。
- `scripts/inspect-live-catalog.mjs`：只读探针，用本机真实 skill 验证目录读取与移除规划。
