import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { projectRoot, loadConfig } from '../src/config.mjs';
import { AiProductFilterAutomation } from '../src/ai-product-filter-runner.mjs';
import { committedAiSnapshot, waitForAiCommit } from '../src/ai-canvas-commit.mjs';
import { AiBlockAutomation } from '../src/ai-runner.mjs';
import { pageContentSnapshot } from '../src/ai-content-ready.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const page = await browser.newPage();
  await page.setContent(`<div id="backstage-bodyArea">
    <div class="ai-container"><button>AI</button></div>
    <div id="old" class="backstage-blocksEditor-wrap block_ai_block_fixture">
      <div class="siteblocks-setting-wrap"><section class="ai-generated-block">Existing content</section></div>
    </div>
    <div id="hidden" class="ai-generated-block" style="display:none">Hidden template</div>
  </div>`);
  const read = () => committedAiSnapshot([page.mainFrame()]);
  const baseline = await read();
  assert.equal(baseline.count, 1);
  assert.deepEqual(baseline.ids, ['old']);
  await page.evaluate(() => {
    document.querySelector('#backstage-bodyArea').insertAdjacentHTML('beforeend',
      '<div id="new" class="siteblocks-setting-wrap"><section class="ai-generated-block">New content</section></div>');
  });
  const committed = await waitForAiCommit(read, baseline, { timeoutMs: 3000, stableMs: 100 });
  assert.equal(committed.count, 2);
  assert.equal(committed.addedId, 'new');
  await page.evaluate(() => document.querySelector('#backstage-bodyArea').insertAdjacentHTML('beforeend',
    '<div id="unmarked" class="siteblocks-setting-wrap">Committed list template without AI class</div>'));
  assert.equal((await committedAiSnapshot([page.mainFrame()], { ownedBlankPage: true })).count, 3);
  await page.evaluate(() => {
    const image = document.createElement('img');
    image.setAttribute('src', 'data:,fixture');
    image.loading = 'lazy';
    Object.defineProperty(image, 'complete', { get: () => false });
    document.querySelector('#unmarked').append(image);
  });
  assert.equal((await pageContentSnapshot([page.mainFrame()])).loading, false);
  assert.equal((await pageContentSnapshot([page.mainFrame()], { editor: true })).loading, true);
  await page.evaluate(() => {
    window.outerClosed = false;
    document.body.insertAdjacentHTML('beforeend', `<div class="header-container"><button class="close-icon-container" onclick="window.outerClosed=true">Outer close</button></div>
      <div class="ai-block-dialog"><div class="ai-dialog-actions"><button title="关闭" onclick="this.closest('.ai-block-dialog').style.display='none'">×</button></div></div>`);
  });
  const base = new AiBlockAutomation({ page }, { ai: {}, paths: {}, selectors: { aiDialogSelector: '.ai-block-dialog' } });
  await base.closeAiGenerationDialog(page.mainFrame());
  assert.equal(await page.evaluate(() => window.outerClosed), false);
  const filterPage = await browser.newPage();
  await filterPage.setContent('<iframe srcdoc="<div class=phoenix2-block-wrap>添加一个新区块</div>"></iframe>');
  const config = await loadConfig();
  config.timeouts.blockRenderMs = 1000;
  const handler = new AiProductFilterAutomation({ page: filterPage }, config, 'fixture');
  const filterFrame = filterPage.frames().find(frame => frame !== filterPage.mainFrame());
  const resultPromise = handler.generatedBlock(filterPage.mainFrame());
  await filterPage.waitForTimeout(50);
  await filterFrame.locator('body').evaluate(body => {
    body.innerHTML = '<div class="phoenix2-block-wrap"><div class="developer-component"><div class="block_productFilter" id="filter-target">Filter fields</div></div></div>';
  });
  const result = await resultPromise;
  assert.equal(result.kind, 'filter-component');
  assert.equal(await result.wrapper.getAttribute('id'), 'filter-target');
  await filterPage.close();
  const dir = path.join(projectRoot, 'output/playwright');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, 'ai-commit-fixture.png') });
  console.log(JSON.stringify({ ok: true, checks: ['nested-wrapper-dedup', 'hidden-template-exclusion', 'placeholder-exclusion', 'unique-commit-barrier', 'lazy-preview-image', 'close-inner-dialog-only', 'filter-component-not-layout'] }));
} finally { await browser.close(); }
