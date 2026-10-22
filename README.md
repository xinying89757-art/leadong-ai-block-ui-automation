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
