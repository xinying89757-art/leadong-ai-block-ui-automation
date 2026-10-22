import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPageCapacityAvailable } from './ai-platform-errors.mjs';
import { comparePageIdentity, pagePath } from './page-identity.mjs';
import { compareHtmlRendering, htmlUploadPassed, uniqueUploadRecord, parseUploadResponse } from './html-upload-state.mjs';

const ROOT = '[data-static-page-layout]';
const DIALOG = '#backstage-dialog-staticPageUpload:visible';
const normalize = text => String(text).normalize('NFKC').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim();

export async function htmlRenderSnapshot(root) {
  return root.evaluate(element => {
    const norm = text => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const rect = element.getBoundingClientRect();
    const shown = n => { const s = getComputedStyle(n); return s.display !== 'none' && s.visibility !== 'hidden' && n.getBoundingClientRect().width > 0; };
    const nodes = [...element.querySelectorAll('h1,h2,h3,h4,p,section,article,main,aside,table,thead,tbody,tr,th,td,svg,img,button,select,a')];
    const keys = ['display','color','backgroundColor','fontSize','fontFamily','fontWeight','lineHeight','borderRadius','textAlign','gap','paddingTop','paddingRight','paddingBottom','paddingLeft'];
    const url = value => { try { const u = new URL(value, location.href); return `${u.origin}${u.pathname}${u.hash}`; } catch { return value; } };
    return {
      text: norm(element.innerText), width: rect.width, height: rect.height,
      headings: [...element.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(n => norm(n.textContent)),
      structure: [...element.querySelectorAll('*')].filter(n => !['STYLE','SCRIPT','LINK'].includes(n.tagName)).map(n => n.tagName.toLowerCase()),
      links: [...element.querySelectorAll('a[href]')].map(n => ({ text: norm(n.textContent), href: (n.getAttribute('href') || '').startsWith('#') ? n.getAttribute('href') : url(n.getAttribute('href')) })),
      media: [...element.querySelectorAll('img,svg,video,canvas')].map(n => ({ tag: n.tagName.toLowerCase(),
        src: n.getAttribute('src') ? url(n.getAttribute('src')) : '', label: n.getAttribute('alt') || n.getAttribute('aria-label') || '',
        paths: n.tagName.toLowerCase() === 'svg' ? [...n.querySelectorAll('path')].map(p => p.getAttribute('d')) : [] })),
      broken_images: [...element.querySelectorAll('img')].filter(n => !n.complete || !n.naturalWidth).length,
      samples: nodes.filter(shown).slice(0, 120).map((n, i) => {
        const r = n.getBoundingClientRect(), s = getComputedStyle(n);
        return { label: `${n.tagName.toLowerCase()} ${norm(n.textContent).slice(0, 25) || i}`,
          style: Object.fromEntries(keys.map(k => [k, s[k]])),
          rect: { x: r.left - rect.left, y: r.top - rect.top, width: r.width, height: r.height } };
      }),
    };
  });
}

export class HtmlUploadAutomation {
  constructor(editor, config, state, paths, persist) {
    Object.assign(this, { editor, config, state, paths, persist });
    this.mode = config.htmlUploadRegression;
  }

  async step(key, fn, { recheck = false } = {}) {
    if (!recheck && this.state.steps[key].status === 'passed') return;
    this.currentStep = key;
    const step = this.state.steps[key];
    Object.assign(step, { status: 'running', started_at: new Date().toISOString(), failure_reason: '' });
    await this.persist();
    try {
      const evidence = await fn();
      Object.assign(step, { status: 'passed', finished_at: new Date().toISOString(), evidence: evidence || {} });
      await this.persist();
    } catch (error) {
      Object.assign(step, { status: 'failed', finished_at: new Date().toISOString(), failure_reason: error.message });
      this.state.failure_step = key;
      throw error;
    }
  }

  async sourceManifest() {
    const source = await this.editor.page.context().newPage();
    try {
      await source.setViewportSize({ width: this.mode.contentWidth, height: this.mode.contentHeight });
      await source.goto(pathToFileURL(this.state.file.path).href, { waitUntil: 'domcontentloaded' });
      const manifest = await source.locator('body').evaluate(body => {
        const norm = s => s.normalize('NFKC').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim();
        const main = body.querySelector('main') || body;
        const included = n => !n.closest('header,footer');
        return { title: document.title, text_length: (main.innerText || '').trim().length,
          headings: [...main.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(included).map(n => norm(n.textContent)).filter(Boolean),
          table_count: [...main.querySelectorAll('table')].filter(included).length,
          svg_count: [...main.querySelectorAll('svg')].filter(included).length,
          image_count: [...main.querySelectorAll('img')].filter(included).length };
      });
      if (!manifest.text_length && !manifest.image_count && !manifest.svg_count) throw new Error('HTML 测试文件没有可验证的正文或图片');
      return manifest;
    } finally { await source.close(); }
  }

  async openUpload() {
    const page = this.editor.page;
    if (await page.locator(DIALOG).count() === 1) return page.locator(DIALOG);
    await this.editor.openCustomPageList();
    const newPage = page.getByText('新建页面', { exact: true }).filter({ visible: true });
    if (await newPage.count() !== 1) throw new Error('新建页面入口不唯一');
    await newPage.click();
    const upload = page.locator('.upload-page-create:visible');
    await upload.waitFor({ state: 'visible' });
    if (await upload.count() !== 1) throw new Error('上传页面入口不唯一');
    await upload.click();
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    return page.locator(DIALOG);
  }

  async waitSettings() {
    const deadline = Date.now() + this.mode.uploadTimeoutMs;
    while (Date.now() < deadline) {
      await assertPageCapacityAvailable(this.editor.page);
      const failure = this.editor.page.locator(`${DIALOG} .static-page-upload-failed-view:visible [data-role="error-message"], ${DIALOG} .static-page-upload-validation:visible`);
      const messages = (await failure.allTextContents()).map(s => s.trim()).filter(Boolean);
      if (messages.length) throw new Error(`HTML 上传解析失败：${messages.join('；').slice(0,300)}`);
      if (await this.editor.page.locator('#backstage-dialog-managePages:visible').count() === 1) return this.editor.pageSettingsDialog();
      await this.editor.page.waitForTimeout(500);
    }
    throw new Error('HTML 上传结果等待超时；保留任务记录，恢复时查询原任务');
  }

  async upload() {
    const dialog = await this.openUpload();
    const file = dialog.locator('input.static-page-upload-file-input');
    if (await file.count() !== 1) throw new Error('HTML 文件输入控件未唯一匹配');
    const page = this.editor.page;
    const pending = new Set();
    let responseError = null;
    const receive = response => {
      const pathname = new URL(response.url()).pathname;
      if (!/\/parse-static-page(?:\/[A-Za-z0-9_-]+\/status)?$/.test(pathname)) return;
      const task = (async () => {
        try {
          const receipt = parseUploadResponse(await response.json(), response.ok());
          if (this.state.upload.record_id && receipt.record_id !== this.state.upload.record_id) return;
          Object.assign(this.state.upload, { record_id: receipt.record_id, last_status: receipt.status, receipt });
          await this.persist();
        } catch (error) { responseError = error; }
      })();
      pending.add(task); task.finally(() => pending.delete(task));
    };
    page.on('response', receive);
    try {
      Object.assign(this.state.upload, { status: 'running', submitted_at: new Date().toISOString() });
      await this.persist();
      await file.setInputFiles({ name: this.state.file.upload_name, mimeType: 'text/html', buffer: await readFile(this.state.file.path) });
      await this.waitSettings();
      await Promise.all([...pending]);
      if (responseError) throw responseError;
      if (!this.state.upload.record_id || this.state.upload.last_status !== 'success') throw new Error('页面设置已打开，但本轮上传成功回执尚未确认');
      this.state.upload.status = 'succeeded';
      return this.state.upload.receipt;
    } finally { page.off('response', receive); await Promise.all([...pending]); }
  }

  async recoverUpload() {
    if (await this.editor.page.locator('#backstage-dialog-managePages:visible').count() === 1) return;
    const dialog = await this.openUpload();
    const responsePromise = this.editor.page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/parse-static-page/list'), { timeout: this.config.timeouts.actionMs });
    if (await dialog.locator('.static-page-upload-history-view:visible').count()) await dialog.getByRole('button', { name: '刷新', exact: true }).click();
    else await dialog.locator('.static-page-upload-history-toggle').click();
    const response = await responsePromise;
    const body = await response.json();
    if (!response.ok() || body.code !== 200 || !Array.isArray(body.data?.list)) throw new Error('上传历史记录读取失败');
    const { record, index } = uniqueUploadRecord(body.data.list, this.state.upload.record_id);
    const cards = dialog.locator('.static-page-upload-history-card');
    await cards.nth(index).waitFor({ state: 'visible' });
    if (await cards.count() !== body.data.list.length) throw new Error('上传历史列表与任务数据不一致，拒绝选择');
    // Cards have no DOM record ID. Confirm the UI timestamp at the response's exact index.
    const timestamp = await cards.nth(index).locator('.static-page-upload-history-meta').innerText();
    const expectedParts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(record.addTime)).match(/\d+/g).map(Number);
    const actualParts = timestamp.match(/\d{4}\/\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2}/)?.[0].match(/\d+/g).map(Number);
    if (JSON.stringify(expectedParts) !== JSON.stringify(actualParts)) throw new Error('上传历史任务时间与界面不一致，拒绝选择');
    if (record.status !== 'success') throw new Error(`原上传任务尚未成功：${record.status}，保留现场，不重新上传`);
    await cards.nth(index).getByRole('button', { name: '使用此记录', exact: true }).click();
    await this.waitSettings();
    this.state.upload.status = 'succeeded';
  }

  async findExistingPage() {
    const menu = await this.editor.openCustomPageList();
    const search = menu.locator('input:visible').first();
    if (await search.count()) { await search.fill(this.state.page.name); await search.press('Enter'); await this.editor.page.waitForTimeout(900); }
    const links = menu.locator('a.name:visible').filter({ hasText: this.state.page.name });
    const identities = [];
    for (const link of await links.all()) {
      const identity = await this.editor.pageLinkIdentity(link);
      if (identity.name === this.state.page.name) identities.push(identity);
    }
    if (identities.length > 1) throw new Error('当前运行存在多个同名页面，拒绝操作');
    if (identities.length && pagePath(identities[0].path) !== pagePath(this.state.page.path)) throw new Error('同名页面路径不匹配，拒绝覆盖');
    await this.editor.dismissPageMenu();
    return identities[0] || null;
  }

  async createPage() {
    const descriptor = this.state.page;
    const dialog = await this.editor.pageSettingsDialog();
    await this.editor.fillPageSettings(dialog, descriptor);
    this.state.creation_submitted_at = new Date().toISOString();
    await this.persist();
    this.editor.insertionPending = true;
    const receipt = await this.editor.submitPageSettings(dialog, descriptor);
    if (!receipt.id) throw new Error('HTML 页面创建缺少实际页面 ID，保留现场');
    Object.assign(descriptor, { id: receipt.id, creation_receipt: receipt });
    await this.persist(); // Never wait for the canvas before recording a successful creation.
    // Let the upload handoff finish before opening menus or switching pages.
    await this.editor.waitForPageLoaded(descriptor.name, descriptor);
    return receipt;
  }

  async ensureTarget() {
    const target = this.state.page;
    const actual = await this.editor.currentPageIdentity();
    if (!comparePageIdentity(target, actual).matched) {
      const identity = await this.editor.openCustomPage(target.name);
      if (identity.id !== target.id || pagePath(identity.path) !== pagePath(target.path)) throw new Error('上传页面身份不匹配，停止保存和发布');
    }
    await this.editor.waitForPageLoaded(target.name, target);
    await this.editor.dismissPageMenu();
    await this.editor.waitForCanvasReady();
  }

  async uniqueRoot(frames) {
    const candidates = [];
    for (const frame of frames) {
      // Only callers' explicit content surfaces; never AI preview frames.
      for (const locator of await frame.locator(ROOT).all().catch(() => [])) {
        if (await locator.isVisible().catch(() => false)) candidates.push({ frame, locator });
      }
    }
    if (candidates.length > 1) throw new Error('页面存在多个上传内容区块，无法唯一验证');
    return candidates[0] || null;
  }

  async calibrate(surface, owner) {
    // Equal content area sizes prevent responsive breakpoints and editor chrome from skewing layout comparisons.
    for (let attempt = 0; attempt < 4; attempt++) {
      const measured = await surface.locator.evaluate(n => ({ width: n.getBoundingClientRect().width, height: innerHeight }));
      const deltaW = this.mode.contentWidth - measured.width, deltaH = this.mode.contentHeight - measured.height;
      if (Math.abs(deltaW) <= 1 && Math.abs(deltaH) <= 1) return;
      const current = owner.viewportSize() || await owner.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      await owner.setViewportSize({ width: Math.max(400, Math.round(current.width + deltaW)), height: Math.max(400, Math.round(current.height + deltaH)) });
      await owner.waitForTimeout(200);
    }
    const width = await surface.locator.evaluate(n => n.getBoundingClientRect().width);
    if (Math.abs(width - this.mode.contentWidth) > this.mode.layoutTolerancePx) throw new Error('无法统一编辑器、预览及公开页的内容宽度');
  }

  async waitRendering(framesProvider, owner, label) {
    const deadline = Date.now() + this.mode.renderTimeoutMs;
    let previous = '', stableSince = 0, surface, snapshot;
    while (Date.now() < deadline) {
      surface = await this.uniqueRoot(framesProvider());
      if (!surface) { await owner.waitForTimeout(300); continue; }
      const id = await surface.locator.getAttribute('id');
      if (this.state.page.content_id && id !== this.state.page.content_id) throw new Error(`${label}上传内容 ID 与本轮不匹配`);
      await this.calibrate(surface, owner);
      await surface.frame.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))])).catch(() => {});
      snapshot = await htmlRenderSnapshot(surface.locator);
      const headings = snapshot.headings.map(normalize);
      const manifest = this.state.evidence.source;
      const complete = snapshot.text.length > 0 && snapshot.broken_images === 0 &&
        manifest.headings.every(h => headings.includes(h)) &&
        snapshot.structure.filter(t => t === 'table').length >= manifest.table_count &&
        snapshot.media.filter(m => m.tag === 'svg').length >= manifest.svg_count;
      const signature = JSON.stringify(snapshot);
      if (complete && previous === signature) {
        if (Date.now() - stableSince >= this.mode.stableMs) return { surface, snapshot };
      } else { previous = signature; stableSince = Date.now(); }
      await owner.waitForTimeout(350);
    }
    this.state.evidence.render_diagnostics = { label, surface_found: Boolean(surface), snapshot: snapshot || null,
      frame_names: framesProvider().map(f=>f.name()), checked_at: new Date().toISOString() };
    const missing = this.state.evidence.source.headings.filter(h => !snapshot?.headings.map(normalize).includes(h));
    throw new Error(`${label}内容未完整加载或未稳定${missing.length ? `，缺少：${missing.join('、')}` : ''}`);
  }

  async editorEvidence(label) {
    await this.ensureTarget();
    const result = await this.waitRendering(() => this.editor.canvasContexts(), this.editor.page, label);
    this.editor.insertionPending = false;
    const identity = await result.surface.locator.evaluate(n => ({ content_id: n.id, block_id: n.closest('[id^="siteblocks-setting-wrap-"]')?.id || '' }));
    if (!identity.block_id) throw new Error('上传内容未落到实际编辑器区块中');
    if (this.state.page.block_id && identity.block_id !== this.state.page.block_id) throw new Error('重新打开后上传区块稳定 ID 发生变化');
    Object.assign(this.state.page, identity);
    const screenshot = path.join(this.paths.artifacts, `${label === '编辑器' ? 'editor' : 'persistence'}.png`);
    await result.surface.locator.screenshot({ path: screenshot, animations: 'disabled' });
    return { ...result.snapshot, screenshot };
  }

  async verifyPreview() {
    const opened = this.editor.page.context().waitForEvent('page', { timeout: this.config.timeouts.actionMs });
    await this.editor.page.locator('.clickToPreview:visible').click();
    const preview = await opened;
    try {
      await preview.waitForLoadState('domcontentloaded');
      const frames = () => preview.frames().filter(f => {
        try { return new URL(f.url()).pathname === this.state.page.path; } catch { return false; }
      });
      const result = await this.waitRendering(frames, preview, '预览');
      const comparison = compareHtmlRendering(this.state.evidence.editor, result.snapshot, this.mode.layoutTolerancePx);
      this.state.evidence.preview = result.snapshot;
      this.state.evidence.preview_comparison = comparison;
      const screenshot = path.join(this.paths.artifacts, 'preview.png');
      await result.surface.locator.screenshot({ path: screenshot, animations: 'disabled' });
      this.state.evidence.preview.screenshot = screenshot;
      if (!comparison.passed) throw new Error(`预览与编辑器展示不一致：${comparison.differences.slice(0,8).join('；')}`);
      return comparison;
    } finally { await preview.close(); }
  }

  async verifyPublic() {
    const page = await this.editor.page.context().newPage();
    const deadline = Date.now() + this.mode.publishTimeoutMs;
    let lastError;
    try {
      await page.waitForTimeout(this.mode.publishInitialWaitMs);
      while (Date.now() < deadline) {
        try {
          const response = await page.goto(this.state.page.publicUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(20000, Math.max(1000, deadline-Date.now())) });
          if (!response?.ok()) throw new Error(`公开页返回 HTTP ${response?.status() || '未知'}`);
          const result = await this.waitRendering(() => [page.mainFrame()], page, '公开页');
          const editorComparison = compareHtmlRendering(this.state.evidence.editor, result.snapshot, this.mode.layoutTolerancePx);
          const previewComparison = compareHtmlRendering(this.state.evidence.preview, result.snapshot, this.mode.layoutTolerancePx);
          this.state.evidence.public = result.snapshot;
          this.state.evidence.public_comparison = { passed: editorComparison.passed && previewComparison.passed, editor: editorComparison, preview: previewComparison };
          const screenshot = path.join(this.paths.artifacts, 'public.png');
          await result.surface.locator.screenshot({ path: screenshot, animations: 'disabled' });
          this.state.evidence.public.screenshot = screenshot;
          if (!this.state.evidence.public_comparison.passed) throw new Error(`公开页展示不一致：${[...new Set([...editorComparison.differences,...previewComparison.differences])].slice(0,8).join('；')}`);
          return this.state.evidence.public_comparison;
        } catch (error) { lastError = error; }
        await this.persist();
        if (Date.now() < deadline) await page.waitForTimeout(Math.min(this.mode.publishPollIntervalMs, deadline-Date.now()));
      }
      throw new Error(`发布后公开页验证超时：${lastError?.message || '内容尚未展示'}`);
    } finally { await page.close(); }
  }

  async run() {
    await mkdir(this.paths.artifacts, { recursive: true });
    await this.step('source', async () => { this.state.evidence.source = await this.sourceManifest(); return this.state.evidence.source; });
    if (!this.state.page.id) {
      const existing = await this.findExistingPage();
      if (existing) {
        if (!this.state.creation_submitted_at) throw new Error('同名测试页面已存在但没有本轮创建提交证据，拒绝覆盖');
        Object.assign(this.state.page, { id: existing.id });
        Object.assign(this.state.steps.creation, { status: 'passed', recovered_from_page_list: true });
        Object.assign(this.state.steps.upload, { status: 'passed' });
        await this.persist();
      } else if (this.state.creation_submitted_at) throw new Error('已提交创建但未找到唯一目标页面；保留现场，不重复提交');
    }
    if (!this.state.page.id) {
      await this.step('upload', async () => {
        if (this.state.upload.record_id) { await this.recoverUpload(); return { recovered_record_id: this.state.upload.record_id }; }
        if (this.state.upload.submitted_at) throw new Error('上传回执不确定，禁止重复上传');
        return this.upload();
      });
      if (!await this.editor.page.locator('#backstage-dialog-managePages:visible').count()) await this.recoverUpload();
      await this.step('creation', () => this.createPage());
    }
    // On every resume, verify the actual page again before trusting previous checks.
    await this.step('editor', async () => { this.state.evidence.editor = await this.editorEvidence('编辑器'); return { content_id: this.state.page.content_id }; }, { recheck: true });
    await this.step('save', async () => { this.editor.unsavedChanges = true; return this.editor.savePage(); });
    await this.step('persistence', async () => {
      // Reload only after stable imported content was saved, never during parsing/insertion.
      await this.editor.page.reload({ waitUntil: 'domcontentloaded' });
      await this.editor.waitForCanvasReady();
      const evidence = await this.editorEvidence('重新打开');
      this.state.evidence.persistence = evidence;
      const comparison = compareHtmlRendering(this.state.evidence.editor, evidence, this.mode.layoutTolerancePx);
      if (!comparison.passed) throw new Error(`保存后内容未持久化或展示改变：${comparison.differences.slice(0,8).join('；')}`);
      return comparison;
    }, { recheck: true });
    await this.step('preview', () => this.verifyPreview(), { recheck: true });
    await this.step('publish', async () => {
      this.state.publish_submitted_at = new Date().toISOString(); await this.persist();
      return this.editor.publishSite();
    });
    await this.step('public', () => this.verifyPublic(), { recheck: true });
    this.state.status = htmlUploadPassed(this.state) ? 'passed' : 'failed';
    this.state.failure_reason = ''; this.state.failure_step = '';
    await this.persist();
    return this.state;
  }
}
