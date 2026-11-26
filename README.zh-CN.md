# Inline Review (`vscode-inline-review`)

[English](./README.md) | **简体中文**

在 VS Code 中提供类似 Cursor 的 **Inline Diff（内联对比）与逐块审批**体验——支持对 AI Agent 的代码修改进行块级（Hunk）/ 文件级 Accept、Reject 或直接逐行编辑。

零配置开箱兼容 **Claude Code（CLI 与插件）、Antigravity、Codex、Gemini CLI、Aider、Cline、OpenCode** 以及任意会修改本地工作区文件的 AI 编码工具或进程。

---

## 核心特性

- **通用多 Agent 支持（零配置）**
  - 采用增量基线引擎（Git 干净文件以 index/HEAD 为基线，已存在未提交修改的脏文件自动拍轻量快照），无需任何 Agent 私有接口或 Hook 即可精准捕获外部写入的改动。
  - 自动过滤你自己的手动保存、Git 切分支（`.git/HEAD` 变更）、`.gitignore` 路径、二进制文件与超大文件。
- **混合双模式 Inline Diff**
  - **主审阅视图**：通过 `inline-review-baseline://` 虚拟基线与**真实可编辑工作区文件**打开原生单栏 Inline Diff，完整保留 IntelliSense、语法诊断、跳转定义与直接敲代码逐行修改。
  - **普通编辑器同步联动**：未审完的文件在普通代码标签页中也会显示绿色新增高亮、红色删除标记（悬停可预览被删旧代码）、左侧 QuickDiff 竖条以及 CodeLens 快捷按钮。
  - **内联视图设置隔离**：仅在聚焦本插件的 Inline Diff 审阅标签页时自动将 `diffEditor.renderSideBySide` 切换为单栏内联模式，切到普通 Git Diff 或关闭审阅后自动还原你的原始全局配置（绝不修改项目的 `.vscode/settings.json`）。
- **块级 / 文件级审批 + 自由手改**
  - 支持按改动块（`Accept Hunk` / `Reject Hunk`）或整文件（`Accept File` / `Reject File`）审批。
  - 审阅期间可直接在编辑器内逐行修改代码，手动调整会保留在当前块中随块一起审批。
  - 当前文件最后一个改动块审完后，自动从 Inline Diff 切回普通编辑器标签页，不强行打断视野。
- **安全撤销栈（`Undo Last Review Action`）**
  - **撤销 `Accept`**：仅回退内存/存储基线，完全不触碰真实代码文件，你或 Agent 后续新增的代码 100% 保留、零行号错位。
  - **撤销 `Reject`**：若之后文件未再变动直接无损恢复；若之后在别处有过新编辑，自动通过确定性 **3-way merge** 适配行号偏移；若新编辑与被拒区域重叠冲突，则拦截提示而绝不盲目覆盖。
- **无打断队列、回收站保护与重启持久化**
  - 外部写入静默进入侧边栏 **Inline Review** 队列和左下角状态栏，不抢占当前编辑器焦点。
  - 拒绝 Agent 新建的文件时会移入系统回收站而非永久删除；拒绝 Agent 删除的文件时会从基线完整恢复。
  - 未审完的基线状态会在工作区存储中持久化，重启 VS Code 不丢失。

---

## 默认快捷键

以下为 Windows/Linux 默认无冲突 `Alt` 组合键，可在 VS Code 键盘快捷方式中自由修改：

| 操作 | 快捷键 | 生效条件 |
| :--- | :--- | :--- |
| Accept 当前块 | `Alt+Y` | 编辑器聚焦且当前文件有待审改动 |
| Reject 当前块 | `Alt+N` | 编辑器聚焦且当前文件有待审改动 |
| Accept 当前文件 | `Alt+Shift+Y` | 当前文件有待审改动 |
| Reject 当前文件 | `Alt+Shift+N` | 当前文件有待审改动 |
| 下一个改动块 | `Alt+]` | 编辑器聚焦且当前文件有待审改动 |
| 上一个改动块 | `Alt+[` | 编辑器聚焦且当前文件有待审改动 |
| 打开 / 切换 Inline Diff 视图 | `Alt+R` | 存在待审文件 |
| 跳转到下一个待审文件 | `Alt+Shift+]` | 存在待审文件 |
| 撤销上一步审批动作 | `Alt+Z` | 存在可撤销的审批记录 |

---

## 插件设置

| 设置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `inlineReview.enabled` | `true` | 是否启用工作区外部修改自动检测 |
| `inlineReview.autoInlineDiff` | `true` | 聚焦本插件审阅标签页时自动开启单栏 Inline Diff，切出时还原全局设置 |
| `inlineReview.autoSaveOnReject` | `true` | Reject 块或文件后自动保存磁盘文件 |
| `inlineReview.excludePatterns` | `[]` | 额外忽略的路径通配符列表（glob） |
| `inlineReview.maxFileSizeKB` | `2048` | 允许追踪的最大单文件体积（KB） |
| `inlineReview.maxBurstFiles` | `50` | 单次突发写入文件数超过该阈值时弹窗确认，避免误导入大量文件 |
| `inlineReview.persistState` | `true` | 重启 VS Code 后是否保留未审完的基线状态 |

---

## 本地构建与安装

```bash
npm install
npm run typecheck
npm test
npm run package
code --install-extension vscode-inline-review-0.1.0.vsix
```
