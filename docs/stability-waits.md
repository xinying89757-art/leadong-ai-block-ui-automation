# 固定等待稳定性盘点（STEP 5）

## 计数口径与限制

只静态读取 `src/`、`scripts/` 中的 JS/MJS 源码；未运行真实站点流程或 verify 脚本。表内行号固定为修改前基线位置，修改后以对应方法/代码检索。

共发现 **147 个等待/定时点**（A=5、B=65、C=77）。另有 `src/ai-article-list-settings-runner.mjs:24` 的 `pause` 包装定义，不重复计入调用点；其两个调用已列入表。计数包括 4 个浏览器夹具 DOM 注入定时器、1 个验证夹具间隔、2 个超时保护定时器。原始匹配共 148 处，因此与约 141 个的估计口径有差异。

- A：已存在可观察条件，替换为条件等待。
- B：需要真实站点验证；动画、iframe/编辑器渲染、防抖、异步历史数量、发布传播等原样保留。
- C：现有轮询/重试节奏、超时上限或夹具时序；只在语义相同时合并辅助函数。

## 完整清单

| 修改前文件:行 | 类别 | 周边意图 | 本次处理 |
|---|---|---|---|
| `src/ai-article-list-settings-runner.mjs:393` | C | waitForFrame：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-article-list-settings-runner.mjs:402` | C | waitUntil：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-article-list-settings-runner.mjs:831` | B | 查询结果稳定检查前给后台异步请求启动窗口 | 保留 |
| `src/ai-canvas-commit.mjs:83` | C | waitForAiCommit：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-composite-cli.mjs:116` | B | 画布 ready 后额外等待编辑器稳定 | 保留 |
| `src/ai-composite-runner.mjs:97` | C | resumeSubmittedGeneration：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-composite-runner.mjs:168` | A | 类型菜单已知 button.block-category-option 可见条件，改 locator.waitFor | 已替换：条件等待（使用 config.timeouts） |
| `src/ai-composite-runner.mjs:177` | B | 选择静态类型后等待菜单状态/关闭动画 | 保留 |
| `src/ai-composite-runner.mjs:206` | B | 动态类型多选后等待状态提交 | 保留 |
| `src/ai-content-ready.mjs:79` | C | waitForCompleteContent：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-detail-content.mjs:29` | A | 站点卡片已有 isVisible 条件，改 locator.waitFor | 已替换：条件等待（使用 config.timeouts） |
| `src/ai-detail-runner.mjs:289` | C | verifyPreview：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-detail-runner.mjs:304` | B | 预览备用地址导航后等待详情区块渲染 | 保留 |
| `src/ai-detail-runner.mjs:354` | B | 发布后首次验证前等待部署传播 | 保留 |
| `src/ai-detail-runner.mjs:379` | C | verifyPublished：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-full-page-diagnose.mjs:54` | B | 诊断前等待编辑器稳定 | 保留 |
| `src/ai-full-page-diagnose.mjs:88` | B | 返回表单后等待视图切换 | 保留 |
| `src/ai-full-page-diagnose.mjs:96` | B | 重开生成记录后等待异步卡片加载 | 保留 |
| `src/ai-full-page-prompt-probe.mjs:103` | C | 条件检查：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-full-page-runner.mjs:34` | C | waitFor：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-full-page-runner.mjs:168` | B | 生成器预热：画布 ready 不代表消息总线 ready | 保留 |
| `src/ai-full-page-runner.mjs:189` | B | 选择编辑器 3.0 后等待生成器预热 | 保留 |
| `src/ai-full-page-runner.mjs:236` | C | openGenerator：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-full-page-runner.mjs:263` | C | waitForFullPageAiEditor：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-full-page-runner.mjs:273` | C | waitForFullPageAiEditor：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-full-page-runner.mjs:294` | B | 提示词防抖状态同步后再提交 | 保留 |
| `src/ai-full-page-runner.mjs:373` | C | waitForGenerationAfterReopen：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-full-page-runner.mjs:413` | B | 历史入口出现后等待记录数异步更新 | 保留 |
| `src/ai-full-page-runner.mjs:781` | B | 发布后首次验证前等待部署传播 | 保留 |
| `src/ai-history-reuse-runner.mjs:341` | C | reopenBlockHistory：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-history-reuse-runner.mjs:384` | B | 历史插入应用后等待画布渲染 | 保留 |
| `src/ai-history-reuse-runner.mjs:413` | B | 发布后首次验证前等待部署传播 | 保留 |
| `src/ai-image-gallery-cli.mjs:93` | B | 画布 ready 后额外等待编辑器稳定 | 保留 |
| `src/ai-input-modes-runner.mjs:22` | C | waitFor：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-input-modes-runner.mjs:113` | B | about:blank 子画布晚于 pagebuilder 就绪 | 保留 |
| `src/ai-input-modes-runner.mjs:207` | B | 历史应用后等待画布渲染和弹窗关闭 | 保留 |
| `src/ai-input-modes-runner.mjs:364` | B | 应用后等待画布渲染和弹窗关闭 | 保留 |
| `src/ai-input-modes-runner.mjs:377` | C | runRecord：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-input-modes-runner.mjs:413` | B | 发布后首次验证前等待部署传播 | 保留 |
| `src/ai-item-retry.mjs:47` | C | waitIdentity：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-item-retry.mjs:83` | B | 发布后首次验证前等待部署传播 | 保留 |
| `src/ai-item-retry.mjs:99` | C | verifySelectedPage：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-mode-points-runner.mjs:21` | C | waitFor：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-mode-points-runner.mjs:205` | C | waitForModeGeneration：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-mode-points-runner.mjs:217` | C | waitForModeGeneration：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-mode-points-runner.mjs:226` | C | waitForModeGeneration：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-mode-points-runner.mjs:348` | B | 应用后等待画布渲染和弹窗关闭 | 保留 |
| `src/ai-mode-points-runner.mjs:380` | C | confirmRefund：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-mode-points-runner.mjs:407` | B | 发布后首次验证前等待部署传播 | 保留 |
| `src/ai-navigation-runner.mjs:22` | C | waitFor：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-navigation-runner.mjs:652` | B | 导航配置保存/应用后等待截图视图稳定 | 保留 |
| `src/ai-navigation-runner.mjs:709` | B | 提交条件超时后的画布渲染兜底 | 保留 |
| `src/ai-navigation-runner.mjs:713` | B | 导航历史应用后等待画布/设置生效 | 保留 |
| `src/ai-paged-runner.mjs:141` | C | historyRecord：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-paged-runner.mjs:159` | B | 历史抽屉插入后等待 Vue 动画以判断是否重试 | 保留 |
| `src/ai-paged-runner.mjs:177` | C | recoverStandardGeneratedResult：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-paged-runner.mjs:202` | B | 已确认提交后等待截图视图稳定 | 保留 |
| `src/ai-paged-runner.mjs:207` | B | 历史应用后等待画布渲染 | 保留 |
| `src/ai-paged-runner.mjs:425` | C | run：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-points.mjs:48` | C | waitForCharge：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-product-filter-runner.mjs:25` | C | waitFor：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-product-filter-runner.mjs:481` | C | configureFilterBeforeApply：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-product-filter-runner.mjs:492` | C | configureFilterBeforeApply：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-product-filter-runner.mjs:658` | B | 关闭点数面板后等待覆盖层消退 | 保留 |
| `src/ai-product-filter-runner.mjs:704` | B | 历史插入后等待 Vue 动画以判断是否原生重试 | 保留 |
| `src/ai-product-filter-runner.mjs:730` | B | 筛选区块应用后等待画布/设置生效 | 保留 |
| `src/ai-product-list-settings-runner.mjs:48` | C | waitFor：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-product-list-settings-runner.mjs:293` | C | settingsPanel：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-product-list-settings-runner.mjs:1318` | B | 后台分类筛选：避免把请求启动前的旧表格当成稳定结果 | 保留 |
| `src/ai-product-list-settings-runner.mjs:1535` | B | popup 事件后等待路由/多窗口稳定以选择预览页 | 保留 |
| `src/ai-product-list-settings-runner.mjs:1802` | C | verifyProductListPreviewWithRetry：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-product-list-settings-runner.mjs:1867` | C | collectFlatProductSnapshot：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-product-list-settings-runner.mjs:1885` | B | 侧栏保存后等待设置生效 | 保留 |
| `src/ai-product-list-settings-runner.mjs:2283` | C | waitForProductListPanel：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-product-list-settings-runner.mjs:2772` | B | 历史应用后等待画布/设置生效 | 保留 |
| `src/ai-product-list-settings-runner.mjs:2815` | C | reopenProductListHistory：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-product-list-settings-runner.mjs:2832` | C | reopenProductListHistory：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-product-list-settings-runner.mjs:2840` | C | reopenProductListHistory：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-product-list-settings-runner.mjs:2882` | B | 虚拟历史列表滚动后等待异步新片段 | 保留 |
| `src/ai-product-list-settings-runner.mjs:2949` | C | reopenProductListHistory：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-runner.mjs:32` | C | waitUntil：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/ai-runner.mjs:183` | B | 编辑器根节点已出现，仍需等动画和消息总线稳定 | 保留 |
| `src/ai-runner.mjs:196` | B | 加载提示关闭条件超时的动画兜底 | 保留 |
| `src/ai-runner.mjs:197` | B | 关闭加载提示后等待弹窗稳定 | 保留 |
| `src/ai-runner.mjs:281` | C | selectType：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-runner.mjs:291` | C | selectType：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-runner.mjs:464` | C | waitForGeneration：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/ai-runner.mjs:536` | B | 关闭旧 AI 结果后等待视图卸载 | 保留 |
| `src/ai-runner.mjs:544` | B | 退出确认层可能延迟挂载，等待遮罩变化 | 保留 |
| `src/ai-runner.mjs:641` | B | 提交条件超时后的画布渲染兜底 | 保留 |
| `src/ai-runner.mjs:651` | B | 应用后等待画布渲染/设置生效 | 保留 |
| `src/ai-runner.mjs:727` | B | 预览点击后等待弹窗及其页面渲染 | 保留 |
| `src/ai-runner.mjs:760` | B | 发布后首次验证前等待部署传播 | 保留 |
| `src/ai-runner.mjs:772` | C | verifyPublished：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/auth.mjs:71` | B | goto 被重定向中断后等待新页面稳定 | 保留 |
| `src/auth.mjs:109` | B | 提交登录后等待登录态/重定向 | 保留 |
| `src/auth.mjs:112` | B | 进入后台后等待登录态稳定 | 保留 |
| `src/auth.mjs:120` | C | automaticLogin：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/composite-category-linkage.mjs:13` | C | waitUntil：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/composite-category-linkage.mjs:164` | C | clickAndCheck：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/composite-category-linkage.mjs:186` | C | clickAndCheck：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/composite-category-linkage.mjs:248` | B | 发布后首次验证前等待部署传播 | 保留 |
| `src/editor.mjs:65` | C | waitFirstVisible：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/editor.mjs:215` | B | 首次 goto 后等待重定向/登录态稳定 | 保留 |
| `src/editor.mjs:221` | B | 认证后再次 goto，等待重定向稳定 | 保留 |
| `src/editor.mjs:231` | A | 站点卡片已经有 count 条件，改为 attached 等待，保留失败后的登录恢复分支 | 已替换：条件等待（使用 config.timeouts） |
| `src/editor.mjs:250` | B | 内容区已出现后额外等待编辑器稳定 | 保留 |
| `src/editor.mjs:269` | C | enterTargetSite：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:316` | C | enterTargetSite：已有条件轮询/重试间隔，保留节奏 | 已归并：公共 helper；间隔/条件不变 |
| `src/editor.mjs:327` | A | 进入编辑器后改等已有 waitForCanvasReady 内容区加号条件 | 已替换：条件等待（使用 config.timeouts） |
| `src/editor.mjs:374` | B | 清空页面搜索后等待结果刷新/防抖 | 保留 |
| `src/editor.mjs:382` | B | 重载后等待页面菜单初始化 | 保留 |
| `src/editor.mjs:398` | B | 关闭阻塞弹窗后等待动画 | 保留 |
| `src/editor.mjs:427` | B | 按页面名搜索后等待列表刷新/防抖 | 保留 |
| `src/editor.mjs:451` | B | 自定义页切换失败重载后等待外壳稳定 | 保留 |
| `src/editor.mjs:487` | B | 系统页切换失败重载后等待外壳稳定 | 保留 |
| `src/editor.mjs:538` | C | dismissPageMenu：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:581` | C | createCustomPage：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:720` | C | waitForPageLoaded：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:740` | C | waitForCanvasReady：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:859` | C | deleteAiBlock：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:884` | C | deleteAiBlock：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:977` | C | closeBlockPanelIfOpen：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:1013` | B | 内容区加号 hover 后等待遮罩/悬浮控件 | 保留 |
| `src/editor.mjs:1022` | C | openContentBlockPanel：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:1181` | C | waitForExactBlockResult：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:1196` | C | waitForExactBlockResult：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:1215` | B | 搜索结果卡片 hover 后等待添加控件 | 保留 |
| `src/editor.mjs:1430` | C | waitForBlockAudit：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:1468` | A | 删除后改轮询已有 auditBlock(blockId) 为空，超时仍返回 false | 已替换：条件等待（使用 config.timeouts） |
| `src/editor.mjs:1518` | C | savePage：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/editor.mjs:1599` | C | publishSite：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/html-upload-runner.mjs:105` | C | waitSettings：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/html-upload-runner.mjs:171` | B | 搜索上传页面后等待结果刷新/防抖 | 保留 |
| `src/html-upload-runner.mjs:232` | C | calibrate：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/html-upload-runner.mjs:243` | C | waitRendering：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/html-upload-runner.mjs:247` | B | 浏览器上下文内 document.fonts.ready 的 3 秒上限 | 保留 |
| `src/html-upload-runner.mjs:259` | C | waitRendering：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/html-upload-runner.mjs:306` | B | 发布后首次验证前等待部署传播 | 保留 |
| `src/html-upload-runner.mjs:323` | C | verifyPublic：已有条件轮询/重试间隔，保留节奏 | 保留 |
| `src/midscene-fallback.mjs:40` | C | 超时保护上限，保留原时间预算 | 已归并：公共 helper；间隔/条件不变 |
| `src/product-category-readiness.mjs:7` | C | 分类树稳定性轮询的默认延迟 | 已归并：公共 helper；间隔/条件不变 |
| `scripts/verify-ai-commit.mjs:59` | C | 验证夹具故意错开 DOM 注入时序 | 保留 |
| `scripts/verify-ai-stability.mjs:22` | C | 验证夹具故意错开 DOM 注入时序 | 保留 |
| `scripts/verify-ai-stability.mjs:23` | C | 验证夹具故意错开 DOM 注入时序 | 保留 |
| `scripts/verify-ai-stability.mjs:24` | C | 验证夹具故意错开 DOM 注入时序 | 保留 |
| `scripts/verify-ai-stability.mjs:25` | C | 验证夹具故意错开 DOM 注入时序 | 保留 |

## 修改结果与辅助函数边界

| 指标（以修改前调用点计数） | 数量 |
|---|---:|
| 修改前等待/定时点 | 147 |
| A：改为明确条件等待 | 5 |
| C：归并到公共 helper，保留轮询/保护时序 | 19 |
| 原样保留 | 123（B=65，C=58） |
| 剩余时间间隔/保护点（包含已经归并的 19 个） | 142（A=0，B=65，C=77） |

以上是基线逻辑点数，不能直接用修改后的 `rg setTimeout` 行数相减：9 个轮询实现共用同一计时器，默认 `delay = sleep` 也没有内联定时器。除去 7 个夹具/保护点，生产固定延迟为 140 个。`pause` 的定义不是第三个调用点。

`src/wait-utils.mjs` 提供：

- `sleep(ms)`：共享 Node 定时延迟；9 个轮询适配器、8 个轮询节奏和分类树的默认 delay 使用它。没有把 Playwright 的所有页面延迟机械改成 Node 延迟（页面关闭时的行为不同）。
- `pollUntil(fn, { timeoutMs, intervalMs, message })`：先检查，假值才等待，返回原始真值；到期抛出 `PollTimeoutError`。默认立即传播检查异常。已有会捕获瞬态异常的适配器显式传 `retryOnError: true`，继续保留最后异常消息；默认间隔和原中文错误信息保留。为与旧循环一致，仍睡完整 interval，不截短最后一次间隔；单次 check 的执行时间不受此循环预算约束，需要时可用 `withTimeout`。
- `retry(fn, { attempts, delayMs, backoff, shouldRetry })`：attempt 从 1 开始，失败且策略允许才按指数退避，最后一次失败直接抛原异常。它只提供基础能力，不替换 `ai-item-retry.mjs` 或复合生成重试的业务安全判断、检查点与扣点约束。
- `withTimeout(promise, ms, message)`：保留原值/拒绝，到期报指定错误，所有退出路径清理保护 timer；不取消底层操作。Midscene 原有同等超时保护改用它。

`ai-content-ready.mjs`、`ai-canvas-commit.mjs`、`product-category-readiness.mjs` 继续保留原有的区块身份、稳定窗口、最小等待和错误处理，只归并计时实现。`ai-paged-runner.mjs` 的截图前 Node 延迟是 B，原样保留；浏览器 evaluate/夹具中的 timer 也保持原样，不能直接引用 Node helper。

5 处条件替换：站点卡片 attached（保留失败后的恢复分支）、内容后台卡片 visible（保留原错误）、复合类型选项 visible（保留原错误）、进入编辑器后复用 `waitForCanvasReady()`、删除区块后轮询现有 audit 为空（超时仍返回 false，其他审计错误仍抛出）。预算取自 `config.timeouts.actionMs/blockRenderMs`，站点卡片保留原 10 秒上限。

## B 类完整清单（需要真实站点验证，均未修改）

以下行号均为修改前位置；具体原因见完整清单。

| 文件 | 行号 |
|---|---|
| `src/ai-article-list-settings-runner.mjs` | 831 |
| `src/ai-composite-cli.mjs` | 116 |
| `src/ai-composite-runner.mjs` | 177, 206 |
| `src/ai-detail-runner.mjs` | 304, 354 |
| `src/ai-full-page-diagnose.mjs` | 54, 88, 96 |
| `src/ai-full-page-runner.mjs` | 168, 189, 294, 413, 781 |
| `src/ai-history-reuse-runner.mjs` | 384, 413 |
| `src/ai-image-gallery-cli.mjs` | 93 |
| `src/ai-input-modes-runner.mjs` | 113, 207, 364, 413 |
| `src/ai-item-retry.mjs` | 83 |
| `src/ai-mode-points-runner.mjs` | 348, 407 |
| `src/ai-navigation-runner.mjs` | 652, 709, 713 |
| `src/ai-paged-runner.mjs` | 159, 202, 207 |
| `src/ai-product-filter-runner.mjs` | 658, 704, 730 |
| `src/ai-product-list-settings-runner.mjs` | 1318, 1535, 1885, 2772, 2882 |
| `src/ai-runner.mjs` | 183, 196, 197, 536, 544, 641, 651, 727, 760 |
| `src/auth.mjs` | 71, 109, 112 |
| `src/composite-category-linkage.mjs` | 248 |
| `src/editor.mjs` | 215, 221, 250, 374, 382, 398, 427, 451, 487, 1013, 1215 |
| `src/html-upload-runner.mjs` | 171, 247, 306 |

## 选择器调整与证据

- `editor.openPageMenu()`：优先 `#backstage_select_pages a.backstage-topToolbar-menuIcon`，它已经在同文件 `waitForPageLoaded()` / 系统页回读里使用；不存在或不可见时保留原文字定位和相邻锚点回退，已展开时仍不点击。
- `ai-paged-runner.historyRecord()`：已知的 `config.selectors.aiHistoryInsertSelector` 优先，role 按钮和纯文字依次回退。该配置已经用于其他历史恢复路径。
- `ai-paged-runner.recoverStandardGeneratedResult()`：先取 `button` 内的“应用模块”，再回退纯文字；两条选择器原本都存在，没有新增未经证实的属性。

## 剩余文字依赖候选

下表记录 `editor.mjs` 和 runners 中仍使用 `getByText` / `textLocators` / 文字关联输入的源代码位置（修改后的行号）。其中有些已限定稳定容器或仅作回退；在得到 DOM/fixture 证据前保留。生成状态、错误提示和内容标题本来需要校验文字，不假定存在可替代属性。其他 `hasText` / 按钮 accessible name 的依赖仍按现有稳定容器限定，不推测新属性。

| 当前文件:行 | 现有文字依赖候选 |
|---|---|
| `src/ai-article-list-settings-runner.mjs:196` | `const insert = card.getByText(/插入\|应用模块\|添加/).first();` |
| `src/ai-article-list-settings-runner.mjs:202` | `const controls = [frame.getByText("应用模块", { exact: true }), frame.locator("button").filter({ hasText: /^应用模块$/ })];` |
| `src/ai-article-list-settings-runner.mjs:285` | `if (await candidate.getByText("编辑区块", { exact: true }).count().catch(() => 0)) matches.push(candidate);` |
| `src/ai-article-list-settings-runner.mjs:376` | `const locator = panelResult.panel.getByText(label, { exact: true });` |
| `src/ai-article-list-settings-runner.mjs:415` | `const fallback = panel.getByText(label, { exact: true }).first();` |
| `src/ai-article-list-settings-runner.mjs:1258` | `const text = this.editor.page.getByText("预览", { exact: true }).first();` |
| `src/ai-detail-runner.mjs:44` | `const locator = scope.getByText(marker, { exact: true }).first();` |
| `src/ai-detail-runner.mjs:269` | `const title = frame.getByText(this.page.content.name, { exact: false }).first();` |
| `src/ai-detail-runner.mjs:323` | `const title = publicPage.getByText(this.page.content.name, { exact: false }).first();` |
| `src/ai-full-page-runner.mjs:170` | `this.editor.page.getByText("网页编辑器3.0", { exact: true }).first(),` |
| `src/ai-full-page-runner.mjs:174` | `const newPage = await firstVisible(this.editor.page.getByText("新建页面", { exact: true }));` |
| `src/ai-full-page-runner.mjs:179` | `this.editor.page.getByText("网页编辑器3.0", { exact: true }).first(),` |
| `src/ai-full-page-runner.mjs:212` | `const notReady = this.editor.page.getByText("AI 编辑器尚未就绪，请稍后重试", { exact: true }).first();` |
| `src/ai-full-page-runner.mjs:218` | `this.editor.page.getByText("确定", { exact: true }).last(),` |
| `src/ai-full-page-runner.mjs:251` | `.getByText("AI 编辑器尚未就绪，请稍后重试", { exact: true })` |
| `src/ai-full-page-runner.mjs:658` | `const candidate = await firstVisible(this.editor.page.getByText("页面设置", { exact: true }));` |
| `src/ai-history-reuse-runner.mjs:358` | `frame.getByText("应用模块", { exact: true }).first(),` |
| `src/ai-navigation-runner.mjs:190` | `const texts = scope.getByText(/编辑导航/, { exact: true });` |
| `src/ai-navigation-runner.mjs:301` | `dialog.getByText("保存", { exact: true }).last(),` |
| `src/ai-navigation-runner.mjs:378` | `panel.getByText("编辑导航", { exact: true }).first(),` |
| `src/ai-navigation-runner.mjs:403` | `dialog.getByText("添加", { exact: true }).first(),` |
| `src/ai-navigation-runner.mjs:411` | `dialog.getByText("保存", { exact: true }).last(),` |
| `src/ai-navigation-runner.mjs:498` | `directPanel.getByText("编辑导航", { exact: true }).first(),` |
| `src/ai-navigation-runner.mjs:520` | `directPanel.getByText("编辑导航", { exact: true }).first(),` |
| `src/ai-navigation-runner.mjs:565` | `scope.getByText("编辑导航", { exact: true }).first().locator("xpath=ancestor::*[.//*[normalize-space()='数据源']][1]"),` |
| `src/ai-navigation-runner.mjs:574` | `panel.getByText("编辑导航", { exact: true }).first(),` |
| `src/ai-navigation-runner.mjs:631` | `dialog.getByText("保存", { exact: true }).last(),` |
| `src/ai-navigation-runner.mjs:677` | `const insert = await firstVisible([card.locator("button.ai-history-insert").first(), card.getByText(/插入\|应用模块/).first()]);` |
| `src/ai-paged-runner.mjs:127` | `card.getByText(/插入/).first(),` |
| `src/ai-paged-runner.mjs:173` | `const moduleControl = await firstVisibleControl((scope) => scope.getByText("应用模块", { exact: true }).first());` |
| `src/ai-product-filter-runner.mjs:328` | `const all = scope.getByText("全选", { exact: true });` |
| `src/ai-product-filter-runner.mjs:339` | `const label = panel.getByText("全选", { exact: true }).first();` |
| `src/ai-product-filter-runner.mjs:559` | `panel.getByText("应用", { exact: true }).first(),` |
| `src/ai-product-filter-runner.mjs:690` | `card.getByText(/插入\|应用模块/).first(),` |
| `src/ai-product-list-settings-runner.mjs:300` | `const fallback = panel.getByText(label, { exact: true }).first();` |
| `src/ai-product-list-settings-runner.mjs:375` | `row.getByText(label, { exact: true }).first(),` |
| `src/ai-product-list-settings-runner.mjs:1874` | `panel.getByText("保存", { exact: true }).first(),` |
| `src/ai-product-list-settings-runner.mjs:1922` | `const candidates = scope.getByText(pattern);` |
| `src/ai-product-list-settings-runner.mjs:2117` | `if (await visible(frame.getByText("编辑区块", { exact: true }).first())) blockEditorFrames.push(frame);` |
| `src/ai-product-list-settings-runner.mjs:2330` | `if (/blockEditorUI/i.test(frame.url()) && await visible(frame.getByText("编辑区块", { exact: true }).first())) editorFrames.push(frame);` |
| `src/ai-product-list-settings-runner.mjs:2687` | `card.getByText(/插入\|应用模块/).first(),` |
| `src/ai-product-list-settings-runner.mjs:2699` | `const module = await visibleControl((scope) => scope.getByText("应用模块", { exact: true }).first(), true)` |
| `src/ai-product-list-settings-runner.mjs:2934` | `card.getByText(/插入\|应用模块/).first(),` |
| `src/ai-runner.mjs:45` | `return scope.getByText(text, { exact: true });` |
| `src/ai-runner.mjs:360` | `const failure = frame.getByText(/润色失败\|提示词润色失败\|润色.*失败\|润色暂不可用/).first();` |
| `src/ai-runner.mjs:428` | `card.getByText(/插入\|应用模块/),` |
| `src/ai-runner.mjs:434` | `if (await visible(frame.getByText(/AI正在生成\|生成中/).first())) metadata.last_record_status = 'running';` |
| `src/ai-runner.mjs:500` | `const progress = await visible(frame.getByText(/AI正在生成\|正在生成区块\|生成中/).first());` |
| `src/editor.mjs:95` | `return patterns.map((pattern) => scope.getByText(regex(pattern)));` |
| `src/editor.mjs:111` | `.getByText(new RegExp(&#96;^\\s*${escapeRegex(label)}\\s*$&#96;, "i"))` |
| `src/editor.mjs:258` | `if (await candidate.getByText(sitePattern).first().isVisible().catch(() => false)) {` |
| `src/editor.mjs:344` | `...textLocators(scope, this.config.selectors.pageMenuTexts),` |
| `src/editor.mjs:366` | `[menu.getByText("自定义页面", { exact: true })],` |
| `src/editor.mjs:391` | `successDialog.getByText(/^关闭$/).first(),` |
| `src/editor.mjs:463` | `const tab = menu.getByText("系统页面", { exact: true }).first();` |
| `src/editor.mjs:481` | `const requestError = this.page.getByText("请求出错", { exact: true }).first();` |
| `src/editor.mjs:483` | `await this.page.getByText("确定", { exact: true }).last().click({ force: true }).catch(() => {});` |
| `src/editor.mjs:546` | `textLocators(this.page, this.config.selectors.newPageTexts),` |
| `src/editor.mjs:554` | `textLocators(this.page, this.config.selectors.editor3CardTexts),` |
| `src/editor.mjs:565` | `...textLocators(editor3Card, this.config.selectors.editorCreateTexts),` |
| `src/editor.mjs:579` | `blankPage = await firstVisible(textLocators(this.page, this.config.selectors.blankPageTexts));` |
| `src/editor.mjs:588` | `textLocators(this.page, this.config.selectors.templateConfirmTexts),` |
| `src/editor.mjs:596` | `textLocators(this.page, this.config.selectors.pageSettingsTexts),` |
| `src/editor.mjs:627` | `this.page.locator('.backstage-dialog:visible').filter({ has: this.page.getByText('页面设置', { exact: true }) })]);` |
| `src/editor.mjs:748` | `await firstVisible([this.page.getByText(name, { exact: true })]),` |
| `src/editor.mjs:774` | `this.page.getByText(/^确定$/, { exact: true }),` |
| `src/editor.mjs:775` | `this.page.getByText(/^删除$/, { exact: true }),` |
| `src/editor.mjs:868` | `scope.getByText(/^确定$/, { exact: true }),` |
| `src/editor.mjs:869` | `scope.getByText(/^删除$/, { exact: true }),` |
| `src/editor.mjs:990` | `...textLocators(scope, this.config.selectors.contentAddTexts ?? []),` |
| `src/editor.mjs:1090` | `...textLocators(card, this.config.selectors.addButtonTexts),` |
| `src/editor.mjs:1119` | `const locator = scope.getByText(exactId);` |
| `src/editor.mjs:1153` | `...textLocators(card, this.config.selectors.addButtonTexts),` |
| `src/editor.mjs:1188` | `textLocators(` |
| `src/editor.mjs:1456` | `textLocators(root, this.config.selectors.deleteBlockTexts),` |
| `src/editor.mjs:1463` | `this.page.getByText(/^(确定\|删除)$/),` |
| `src/editor.mjs:1484` | `...textLocators(this.page, this.config.selectors.saveTexts),` |
| `src/editor.mjs:1518` | `textLocators(this.page, this.config.selectors.saveSuccessTexts),` |
| `src/editor.mjs:1537` | `...textLocators(this.page, this.config.selectors.publishTexts),` |
| `src/editor.mjs:1563` | `...textLocators(this.page, this.config.selectors.publishConfirmTexts),` |
| `src/editor.mjs:1573` | `const label = dialog.getByText(/^我已确认$/).first();` |
| `src/editor.mjs:1578` | `dialog.getByText(/^发布$/).last(),` |
| `src/editor.mjs:1589` | `textLocators(this.page, this.config.selectors.publishSuccessTexts),` |
| `src/html-upload-runner.mjs:86` | `const newPage = page.getByText('新建页面', { exact: true }).filter({ visible: true });` |

## 离线验证

新增 `test/wait-utils.test.mjs` 覆盖轮询返回值、立即检查、异常策略、截止条件、间隔、退避与停止策略、超时保护清理，以及整页适配器兼容性。新增 `test/stability-waits.test.mjs` 用 mock 覆盖 5 处条件替换和选择器优先级/回退，不启动浏览器、不访问站点。

默认 `npm test` 在当前环境只报告测试文件级结果；额外通过 `npm test -- --experimental-test-isolation=none` 展开实际单元用例验证。没有修改测试脚本、既有断言、浏览器测试或 `src/config.mjs` 的环境加载逻辑。浏览器测试按其既有逻辑，在 Chromium/本地监听受限时跳过。

本次新增 16 个单元用例。最终展开验证摘要：`tests 215 / suites 0 / pass 213 / fail 0 / cancelled 0 / skipped 2 / todo 0`。两项跳过分别为 `composite-category-linkage` 的 Chromium 启动受限和 `page-settings-ui` 的本地 HTTP 监听受限；未调整它们的代码或断言。
