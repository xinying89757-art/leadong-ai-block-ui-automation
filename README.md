# Leadong AI UI automation

Reusable Playwright automation for the Leadong 3.0 editor and MoliAI workflows. The default site configuration targets the English `xujiying-ai区块` test site. The live domain and site name are in `config/run.json`; credentials are intentionally not stored in the repository.

## Included verified workflows

The checked-in commands cover:

- The 15 non-detail AI block types, arranged as three pages of five. This includes product filtering and navigation, with editor, preview, publish, and public-page checks.
- Article, gallery, and video detail blocks. Product detail is not covered because it is unavailable in the AI type menu.
- Static image/text generation in quick, advanced, and deep modes, including the expected 6/10/20-point balance checks.
- Static image/text input by text description, image upload, and reference URL.
- Full-page AI generation and the full-page plus block generation-history reuse flows.
- Product-list settings and article-list settings regression commands.
- The separate `图片集` block, composite blocks, and composite product-category navigation/filter verification.
- HTML page upload, followed by editor, preview, publish, and public-page comparison.

The full regression suite has a saved passing run; separate passing live runs also exist for image gallery, composite workflows, product-category linkage, and HTML upload. Article-list settings has a runnable script and tests, but its saved run has limitations for some setting-effect assertions, so it is not represented as fully verified. The live site is nondeterministic; a passing run does not guarantee every future generation attempt succeeds on its first try.

## Setup

Requirements: Node.js 20+, macOS with Google Chrome installed, and authorized access to the configured test site.

```sh
npm ci
cp .env.example .env.local
```

Edit `.env.local` locally and load it in the shell before running commands:

```sh
set -a
source .env.local
set +a
```

Set `BUG1004949_ADMIN_ACCOUNT` and `BUG1004949_ADMIN_PASSWORD`, or set `BUG1004949_ADMIN_CONFIG` to a JSON file outside this repository containing `account` and `password`. `.env.local`, external credential files, Playwright login state, and runtime state are ignored by Git. Do not paste credentials into source, reports, or commits.

图片输入流程默认使用仓库内的 `fixtures/images/ai-block-test-image.png`。如需指定其他本地图片，可设置 `AIBLOCK_TEST_IMAGE` 为绝对路径或仓库相对路径。配置中的相对路径始终以仓库根目录为基准，与当前工作目录无关。

`BUG1004949_ADMIN_CONFIG` 为可选项，可指向包含 `account` 和 `password` 的外部 JSON 文件。未设置时，登录流程使用 `BUG1004949_ADMIN_ACCOUNT` 和 `BUG1004949_ADMIN_PASSWORD`。只有流程确实需要登录时才要求提供账号密码。AI 区块流程不会读取旧的 `rankingWorkbook` 配置，该项已移除。

The HTML upload fixture is included at `fixtures/html-upload/pulse-dashboard.html`.

## Common commands

```sh
npm test
npm run ai:regression
npm run ai:regression:status
npm run ai:regression:resume
```

The full regression performs live generation and may spend account points, create pages, save changes, and publish to the configured test site. Prefer a focused command when validating one workflow. Most focused commands provide `:resume` and `:status`; commands that create test pages may also provide `:cleanup`. Check the corresponding `package.json` script and state/report output before running a publishing or cleanup command.

Focused entry points include:

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

## Runtime data

Generated reports, screenshots, browser profile data, authentication state, and run state are local-only and excluded from Git. The scripts write them under `reports/`, `output/`, `.auth/`, and `.state/` as applicable. Preserve those directories locally if you need resume behavior; they are not part of a fresh clone.
