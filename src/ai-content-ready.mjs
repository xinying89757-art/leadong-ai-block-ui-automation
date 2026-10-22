import { createHash } from "node:crypto";

// Count real page blocks, never the AI result iframe or preview toolbar.
export async function pageContentSnapshot(frames, { editor = false } = {}) {
  let best = { count: 0, readyCount: 0, loading: true, fingerprint: "" };
  for (const frame of frames) {
    // The AI editor contains nested about:blank copies of the generated
    // canvas. They must never count as committed 3.0 page blocks.
    let aiResultFrame = false;
    for (let ancestor = frame; ancestor; ancestor = ancestor.parentFrame?.()) {
      if (ancestor.url?.().includes("/blockEditorUI/")) { aiResultFrame = true; break; }
    }
    if (aiResultFrame) continue;
    const areaExists = await frame.locator("#backstage-bodyArea").count().catch(() => 0);
    const scope = frame.locator(editor || areaExists ? "#backstage-bodyArea" : "body").first();
    // Missing containers in auxiliary/AI frames must not consume Playwright's
    // default 30s locator wait on every poll.
    if (!(await scope.count().catch(() => 0))) continue;
    const data = await scope.evaluate((area, options) => {
      const selectors = [".siteblocks-setting-wrap", ".phoenix2-block-wrap", ".backstage-blocksEditor-wrap", "[data-px2-page-id]", ".block-container[class*='block-settingId-ai-copilot']"];
      let blocks = [];
      for (const selector of selectors) {
        const nodes = [...area.querySelectorAll(selector)].filter((node) =>
          !node.parentElement?.closest(selector) && node.getClientRects().length > 0);
        if (nodes.length) { blocks = nodes; break; }
      }
      // Frontend images below the fold may be intentionally lazy-loaded.
      // They must not hold an otherwise complete page in Loading forever.
      const pendingImageCount = [...area.querySelectorAll('img[src]')].filter(image => {
        if (image.complete) return false;
        if (options.editor) return true;
        const rect = image.getBoundingClientRect();
        return image.loading !== 'lazy' && rect.width > 0 && rect.height > 0 &&
          rect.top < window.innerHeight && rect.bottom > 0;
      }).length;
      const pendingImages = pendingImageCount > 0;
      const loading = pendingImages || [...area.querySelectorAll(".loadingMask2, .el-loading-mask, [aria-busy='true']")]
        .some((node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
      const readyCount = blocks.filter((block) => {
        const text = (block.innerText || "").replace(/添加在这里|暂无内容|加载中|Loading\.\.\./gi, "").trim();
        return text.length > 0 || [...block.querySelectorAll("img, video, iframe, svg, input, button")]
          .some((node) => node.tagName !== "IMG" || (node.complete && node.naturalWidth > 0));
      }).length;
      return { count: blocks.length, readyCount, loading, pendingImageCount,
        blockIds: blocks.map((node) => node.id || node.getAttribute("data-px2-page-id") || "").filter(Boolean),
        // Animation styles, dynamic counters and accordion visibility are
        // not evidence of new block insertion. Use stable structural IDs.
        fingerprint: blocks.map(node => `${node.id}:${node.getAttribute('data-px2-page-id') || ''}:${node.childElementCount}`).join('|') };
    }, { editor }, { timeout: 1000 }).catch(() => null);
    if (data && data.count > best.count) best = { ...data, fingerprint: createHash("sha256").update(data.fingerprint).digest("hex") };
  }
  return best;
}

export async function waitForCompleteContent(read, {
  expectedCount, timeoutMs = 300000, stableMs = 3000, pollMs = 500, observe = async () => {}, scope = 'application', label = '整页区块添加', identityMismatchTimeoutMs = 15000,
}) {
  if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error("生成记录区块总数数据不可用，拒绝刷新或保存");
  const deadline = Date.now() + timeoutMs;
  let fingerprint = "", stableSince = 0, last;
  let mismatchSince = 0;
  while (Date.now() < deadline) {
    last = await read();
    await observe(last);
    if (last.identityMismatch) {
      mismatchSince ||= Date.now();
      if (Date.now() - mismatchSince >= identityMismatchTimeoutMs) {
        const error = new Error('页面身份不匹配：实际页面 ID 持续与目标不同，禁止刷新、保存或发布');
        error.code = 'PAGE_IDENTITY_MISMATCH'; error.snapshot = last; throw error;
      }
    } else mismatchSince = 0;
    const ready = last.targetMatched !== false && last.applicationMatched !== false && !last.loading &&
      last.count === expectedCount && last.readyCount === expectedCount;
    if (!ready) { stableSince = 0; fingerprint = ""; }
    else {
      if (!stableSince || fingerprint !== last.fingerprint) { stableSince = Date.now(); fingerprint = last.fingerprint; }
      if (Date.now() - stableSince >= stableMs) return { ...last, stableMs, expectedCount };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  const identityProblem = last?.targetMatched === false ? '，当前页面与测试目标不一致' :
    last?.applicationMatched === false ? '，无法确认是本轮新增内容' : '';
  const error = new Error(`${scope === 'application' ? '应用状态不确定：' : ''}${label}等待超时：就绪 ${last?.readyCount ?? 0}/${expectedCount}，检测到 ${last?.count ?? 0} 个区块${last?.loading ? '，仍有加载状态' : ''}${identityProblem}${scope === 'application' ? '；禁止刷新、保存或发布' : ''}`);
  error.code = scope === 'application' ? 'APPLICATION_INCOMPLETE' : 'CONTENT_RENDER_TIMEOUT';
  error.snapshot = last;
  throw error;
}
