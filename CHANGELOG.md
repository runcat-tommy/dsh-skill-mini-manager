# CHANGELOG

## 1.0.1

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

## 1.0.0

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
