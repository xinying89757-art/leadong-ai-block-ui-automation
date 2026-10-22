// Temporary AI editors have nested canvases, sometimes with identical IDs.
export function isTemporaryAiFrame(frame) {
  for (let current = frame; current; current = current.parentFrame?.()) {
    if (/\/blockEditorUI\//.test(current.url?.() || '')) return true;
  }
  return false;
}

export async function committedIdentityCount(scope, identity) {
  if (!identity) return 0;
  let count = 0;
  for (const frame of scope.frames()) {
    if (isTemporaryAiFrame(frame)) continue;
    const found = await frame.locator('[id]').evaluateAll((nodes, id) => nodes.filter(node => node.id === id).length, identity).catch(() => 0);
    count = Math.max(count, found);
  }
  return count;
}

export async function committedIdentityEvidence(scope, identity) {
  let best = { count: 0, ready: false };
  if (!identity) return best;
  for (const frame of scope.frames()) {
    if (isTemporaryAiFrame(frame)) continue;
    const data = await frame.locator('[id]').evaluateAll((nodes, id) => {
      const matches = nodes.filter(node => node.id === id);
      if (matches.length !== 1) return { count: matches.length, ready: false };
      const node = matches[0], style = getComputedStyle(node);
      const visible = node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      const loading = [...node.querySelectorAll('.el-loading-mask, .loadingMask2, [aria-busy="true"]')]
        .some(child => child.getClientRects().length > 0 && getComputedStyle(child).visibility !== 'hidden');
      const text = node.innerText?.replace(/添加在这里|加载中|Loading\.{0,3}/gi, '').trim();
      const media = [...node.querySelectorAll('img[src], video, iframe[src]')]
        .some(child => child.getClientRects().length > 0 && (child.tagName !== 'IMG' || child.complete && child.naturalWidth > 0));
      return { count: 1, ready: visible && !loading && Boolean(text || media) };
    }, identity).catch(() => null);
    if (data && (data.count > best.count || data.count === best.count && data.ready)) best = data;
  }
  return best;
}

export async function committedAiSnapshot(frames, { ownedBlankPage = false } = {}) {
  let best = { count: 0, ids: [], ready: false };
  for (const frame of frames) {
    if (isTemporaryAiFrame(frame)) continue;
    const root = frame.locator('#backstage-bodyArea').first();
    if (!await root.count().catch(() => 0)) continue;
    const data = await root.evaluate((area, options) => {
      // Some list/category templates strip the AI marker on commit. On an
      // automation-owned blank page, the unique post-apply wrapper is still
      // attributable to this action even without that optional class.
      const selector = options.ownedBlankPage
        ? '.backstage-blocksEditor-wrap, .siteblocks-setting-wrap, .phoenix2-block-wrap, .ai-generated-block, .block-container[class*="block-settingId-ai-copilot"]'
        : ".backstage-blocksEditor-wrap[class*='block_ai_block_'], .block-container[class*='block-settingId-ai-copilot'], .siteblocks-setting-wrap:has(.ai-generated-block), .ai-generated-block";
      const nodes = [...area.querySelectorAll(selector)].filter(node =>
        !node.parentElement?.closest(selector) && node.getClientRects().length > 0);
      const ids = nodes.map(node => node.id || node.getAttribute('data-px2-page-id') || node.querySelector('[id]')?.id || '');
      const loading = [...area.querySelectorAll('.loadingMask2, .el-loading-mask, [aria-busy="true"]')]
        .some(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
      const ready = nodes.every(node => !!node.innerText?.replace(/添加在这里|加载中|Loading\.\.\./gi, '').trim() ||
        !!node.querySelector('img[src], video, iframe, svg, input, button'));
      return { count: nodes.length, ids, ready: ready && !loading };
    }, { ownedBlankPage }, { timeout: 1000 }).catch(() => null);
    if (data && (data.count > best.count || (data.count === best.count && data.ready))) best = data;
  }
  return best;
}

export async function waitForAiCommit(read, baseline, { timeoutMs = 60000, stableMs = 1000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0, lastKey = '', last;
  while (Date.now() < deadline) {
    last = await read();
    const added = last.ids.filter(id => id && !baseline.ids.includes(id));
    const valid = last.ready && last.count === baseline.count + 1 && added.length === 1 &&
      baseline.ids.every(id => id && last.ids.includes(id));
    const key = JSON.stringify(last.ids);
    if (!valid) { stableSince = 0; lastKey = ''; }
    else {
      if (!stableSince || key !== lastKey) { stableSince = Date.now(); lastKey = key; }
      if (Date.now() - stableSince >= stableMs) return { ...last, addedId: added[0] };
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
  const error = new Error(`应用状态不确定：3.0 正文未确认唯一新增 AI 区块（${baseline.count} → ${last?.count ?? 0}），该页面隔离`);
  error.code = 'AI_COMMIT_UNCONFIRMED';
  throw error;
}
