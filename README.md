# Leadong AI 区块 UI 自动化

用于 Leadong 3.0 编辑器和 MoliAI 流程的 Playwright 自动化工具。默认站点配置指向英语站点 `xujiying-ai区块`。目标域名和站点名称配置在 `config/run.json`；仓库不会保存账号凭据。

## 已覆盖的流程

仓库中的命令覆盖以下流程：

- 15 种非详情 AI 区块，分为三页、每页五种；包含产品筛选和导航，并检查编辑器、预览、发布及公开页面。
- 文章、图册和视频详情区块。AI 类型菜单中没有产品详情，因此未覆盖该项。
- 静态图文的快速、进阶和深度模式，并检查预期的 6/15/30 点数变化。
- 通过文字描述、图片上传和参考网址生成静态图文。
- AI 整页生成，以及整页和区块生成历史复用流程。
- 产品列表设置和文章列表设置回归命令。
- 独立的 `图片集` 区块、复合区块，以及复合产品分类导航/筛选验证。
- HTML 页面上传，以及编辑器、预览、发布和公开页面对比。

完整回归套件有已保存的通过记录；图片集、复合流程、产品分类关联和 HTML 上传也有各自的线上通过记录。文章列表设置有可运行的脚本和测试，但已保存的运行记录无法覆盖部分设置效果断言，因此不列为完全验证。线上生成存在不确定性，单次通过不代表后续每次都能首次成功。

## 安装与配置

需要 Node.js 20+ 和目标测试站点的授权访问权限。macOS 默认使用已安装的 Google Chrome 并显示浏览器窗口；Linux/CI 可使用 Playwright 自带的 Chromium。

```sh
npm ci
cp .env.example .env.local
```

将 `.env.example` 复制为 `.env.local` 并填写本地配置。CLI 会自动读取仓库根目录下的 `.env.local`；已设置的 shell 环境变量优先。该文件可选且不会提交。

管理员登录配置如下。`LEADONG_ADMIN_CONFIG` 指向的 JSON 文件应位于仓库外，并包含 `account` 和 `password`。变量优先级为 `LEADONG_*`、`AIBLOCK_*`、`BUG1004949_*`（最后一组仅兼容管理员配置）。`.env.local`、外部凭据文件、Playwright 登录状态和运行状态均为本地文件，不要将凭据写入源码、报告或提交记录。

| 变量 | 用途 |
| --- | --- |
| `LEADONG_ADMIN_ACCOUNT` | 管理员账号 |
| `LEADONG_ADMIN_PASSWORD` | 管理员密码 |
| `LEADONG_ADMIN_CONFIG` | 可选的外部 JSON 凭据文件路径 |
| `LEADONG_TEST_IMAGE` | 可选的本地图片路径；默认 `fixtures/images/test-image.png` |
| `UI_STORAGE_STATE` | 可选的 Playwright 登录状态文件 |
| `UI_PROXY` | 可选代理；默认直连 |
| `MIDSCENE_MODEL_API_KEY` | 仅视觉回退流程需要 |

图片输入流程默认使用仓库内的 `fixtures/images/test-image.png`。如需指定其他本地图片，可设置 `LEADONG_TEST_IMAGE` 为绝对路径或仓库相对路径。配置中的相对路径始终以仓库根目录为基准，与当前工作目录无关。只有流程确实需要登录时才要求提供账号密码。

HTML 上传样例位于 `fixtures/html-upload/pulse-dashboard.html`。

## Linux / CI 运行

安装依赖后，Linux 可安装 Playwright 自带的 Chromium：

```sh
npx playwright install chromium
```

设置 `CI` 环境变量时，浏览器默认以 headless 模式启动。可用以下变量覆盖浏览器配置；`LEADONG_BROWSER_CHANNEL` 留空或设为 `chromium` 时使用 Playwright 自带的 Chromium，设为 `chrome` 时使用 Google Chrome。CI 默认 headless 并使用内置 Chromium；macOS 默认保持 headed Chrome 和现有操作延迟。

| 变量 | 用途 |
| --- | --- |
| `LEADONG_BROWSER_CHANNEL` | 浏览器 channel：`chrome`、`msedge`、`chromium` 或空值；未设置时沿用配置（非 CI 默认 `chrome`） |
| `LEADONG_TEST_BROWSER_CHANNEL` | 仅覆盖分类联动的本地浏览器测试 channel；未设置时使用 `chromium` |
| `LEADONG_HEADLESS` | 覆盖显示模式，接受 `true`/`false` 或 `1`/`0`；未设置时 CI 默认 headless，非 CI 沿用配置 |
| `LEADONG_SLOW_MO` | 覆盖 Playwright 操作延迟，单位毫秒，必须为非负整数；旧 `AIBLOCK_SLOWMO` 也可作为后备 |

如果 Linux/CI 环境禁止出站 TCP 80，预览入口可能从 HTTPS 重定向到 HTTP 并超时。这是环境限制。可选 workaround：`LEADONG_HTTPS_UPGRADE_HOSTS=website.leadong.com npm run ai:modify -- --run-id linux-preview-01`。`network.httpsUpgradeHosts` 默认 `[]`，环境变量接受逗号分隔的精确主机名（空值关闭）。启用后预览目标先升级到 HTTPS，context 路由将指定主机的 HTTP 请求通过 HTTPS 代理，并升级响应 Location；方法、请求头、请求体和响应状态/内容保持一致，覆盖 iframe 和 popup。未指定时 macOS 行为不变。HTTP 导航超时报告为 `preview_status: blocked-environment`，仍不算通过。若 HTTPS 端强制跳回相同 HTTP 地址，runner 会检测该循环并记录环境阻塞；shim 要求实际目标能够通过 HTTPS 提供内容。

## 启用 CI

CI 工作流模板位于 `ci/github-actions/offline-tests.yml`。启用时将其复制到 GitHub Actions 识别的目录：

```sh
mkdir -p .github/workflows && git mv ci/github-actions/offline-tests.yml .github/workflows/ci.yml
```

该工作流只运行离线测试，不登录、不访问真实站点、不消耗积分。

## 常用命令

```sh
npm test
npm run ai:regression
npm run ai:regression:status
npm run ai:regression:resume
```

完整回归会在目标站点执行生成，可能消耗账号点数、创建页面、保存更改并发布。验证单项流程时可使用对应的专项命令。多数专项命令提供 `:resume` 和 `:status`；创建测试页面的命令还可能提供 `:cleanup`。执行发布或清理前，请先查看对应的 `package.json` 命令及状态/报告输出。

专项命令包括：

```sh
npm run ai:add
npm run ai:remaining
npm run ai:detail
npm run ai:mode-points
npm run ai:input-modes
npm run ai:full-page
npm run ai:history-reuse
npm run ai:image-gallery
npm run ai:composite
npm run ai:composite:products
npm run page:html-upload
```

## 运行数据

生成的报告、截图、浏览器配置、认证状态和运行状态仅保存在本地，并已从 Git 排除。脚本会按需将其写入 `reports/`、`output/`、`.auth/` 和 `.state/`。如需恢复运行，请保留这些目录；新克隆的仓库不包含这些数据。


## 本地测试

所有配置中的本地文件、状态和输出路径以仓库根目录解析，绝对路径保持原样。

AI 生成模式与预期点数由 `ai.generationModes` 统一配置：快速模式 6 点、进阶模式 15 点（接受旧称“高级模式”）、深度模式 30 点。

### Existing AI block modification and result actions

Both flows use headless Chromium and create isolated, unpublished regression pages. Local credentials are loaded by `loadConfig()`; do not inspect the session directory or print credentials.

```sh
npm run ai:modify -- --run-id modify-example
npm run ai:modify:resume -- --run-id modify-example
npm run ai:modify:status -- --run-id modify-example
npm run ai:modify:cleanup -- --run-id modify-example --apply

npm run ai:result-actions -- --run-id result-actions-example
npm run ai:result-actions:resume -- --run-id result-actions-example
npm run ai:result-actions:status -- --run-id result-actions-example
npm run ai:result-actions:cleanup -- --run-id result-actions-example --apply
```

The underlying CLI requires `--apply` for run, resume and cleanup. Run IDs are validated and cannot be reused. With no ID, status/resume/cleanup use the flow's active-run pointer. State lives under `.state/ai-lifecycle/runs/<runId>/ai-<flow>/`; JSON/Markdown reports and screenshots live under `reports/ai-<flow>/<runId>/`.

`ai.modifyRegression.modes` defaults to `["quick", "advanced"]`; add `"deep"` to exercise deep modification. Costs come from `ai.generationModes`. The seed is always a quick static image/text block. Each modification must replace the heading inside the owned committed block and appear in preview.

`ai.resultActionsRegression.mode` defaults to `"quick"`. Separate generations on independently recorded test pages exercise prompt preservation, regeneration with history and credit checks, direct application, and both changed-content exit branches. A failed commit is isolated while the remaining independent cases run. The commit barrier excludes temporary AI canvases and requires a stable count increase of exactly one, the generated heading and a cleared overlay. Both applied blocks are checked in preview. Cleanup requires a matching creation receipt and page identity and deletes only that run's page; neither flow publishes.

A run exits unsuccessfully when an application or preview assertion fails. A completed history record is never enough to mark application successful. Modification can recover its own completed history record in the same modification context; the report records blank/disabled result observations. Preview is loaded from the editor’s own preview link in a separate tab, and its endpoint must return the expected heading. No publish fallback is used.

## 生成历史（Flow 3）

`ai:history` 在独立 `AI生成历史回归-<runId>` 页面生成一个快速模式区块，检查生成记录徽标 +1、全部分页记录的时间倒序、状态/输入方式/模式/类型/点数徽标，以及自己的完成记录「＋插入」后的画布标题与零额外扣点。若历史中有真实的可恢复组合失败记录，则在测试页面中执行「继续生成」，等待该记录完成并记录扣点；没有可用失败记录时明确标记 skipped，不伪造失败。不会发布。

```sh
LEADONG_HTTPS_UPGRADE_HOSTS=website.leadong.com npm run ai:history -- --run-id history-example
npm run ai:history:resume -- --run-id history-example
npm run ai:history:status -- --run-id history-example
npm run ai:history:cleanup -- --run-id history-example --apply
```

配置为 `ai.historyRegression`。run/resume/cleanup 必须 `--apply`（前两者的 npm 脚本已包含）。状态和创建回执记录在 lifecycle 目录，JSON/Markdown 与截图在 `reports/ai-history/<runId>/`。恢复只读取/使用已提交的记录，不重复提交已扣点生成；应用状态不确定时先检查画布。cleanup 只删除该 run 的精确归属页面。

## 输入校验与积分（Flow 5）

`ai:validation` 在独立 `AI输入校验回归-<runId>` 页面检查空提示词、GIF/BMP、超过 5 MiB 的 PNG、有效 PNG 和三个无效网址。拒绝场景必须有错误信息或禁用生成/拒绝文件的证据，同时积分和历史总数不变。有效 PNG 只验证接受，不生成。最后只用文字描述生成一次快速模式区块，核对设置面板实际扣 6 点，并在「查看使用记录」中按时间、使用类型和点数匹配唯一记录。不会发布。

```sh
LEADONG_HTTPS_UPGRADE_HOSTS=website.leadong.com npm run ai:validation -- --run-id validation-example
npm run ai:validation:resume -- --run-id validation-example
npm run ai:validation:status -- --run-id validation-example
npm run ai:validation:cleanup -- --run-id validation-example --apply
```

配置为 `ai.validationRegression`；积分场景固定快速模式。小型真实 GIF/BMP 在 `fixtures/validation/`；有效 PNG 在 `fixtures/images/test-image.png`；大 PNG 运行时生成到 gitignored `tmp/validation/<runId>/`。状态、创建回执、断点和报告遵循其它新流程模式，报告在 `reports/ai-validation/<runId>/`。如果无效输入意外触发生成，记录真实失败及扣点/历史证据；恢复不会重做这笔意外生成。run/resume/cleanup 有 `--apply` 保护。
