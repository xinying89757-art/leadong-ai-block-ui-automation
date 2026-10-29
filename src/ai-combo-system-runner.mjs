import { ComboCategoryLinkage } from './combo-category-linkage.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AiCompositeRegressionAutomation } from './ai-composite-runner.mjs';
import { createInitialAiState, assertAiStateCompatible } from './ai-state.mjs';
import { aiPageDescriptor } from './config.mjs';
import { comboSubblockPattern } from './ai-combo-prompt.mjs';
import { snapshotSystemPageBlocks, assertSystemPageRestored, countOwnedSystemPageBlocks } from './ai-system-page-snapshot.mjs';

export class AiComboSystemPageAutomation extends AiCompositeRegressionAutomation {
  constructor(editor, config, store, pageNumber = 1, systemPage, categoryType = '') {
    super(editor, config, store, pageNumber);
    this.systemPage = systemPage;
    this.categoryType = categoryType;
  }

  async editorAiBlockCount() {
    const record = this.state?.types?.[0];
    const ownId = this.state?.ownership?.identity?.id || record?.committed_block_id || '';
    return countOwnedSystemPageBlocks(await this.canvasSnapshot(), ownId);
  }

  async initialize({ resume = false } = {}) {
    await this.editor.openSystemPage(this.systemPage);
    const identity = await this.editor.currentPageIdentity();
    if (identity.name !== this.systemPage || !identity.id) throw new Error(`系统页面身份无法确认：${this.systemPage}`);
    const existing = await this.store.load();
    if (existing) {
      assertAiStateCompatible(existing, this.config);
      if (existing.run_id !== this.config.ai.runId || existing.page?.name !== this.systemPage || existing.page?.path !== `system:${this.systemPage}` ||
          existing.page?.target_identity?.id !== identity.id) throw new Error('恢复状态与当前系统页面身份不一致');
      this.state = existing;
      if (this.state.page.system_page_snapshot?.length) {
        const now = await snapshotSystemPageBlocks(this.editor.canvasContexts());
        const baseline = this.state.page.system_page_snapshot;
        const ownedId = this.state.ownership?.identity?.id;
        const allowed = JSON.stringify(now) === JSON.stringify(baseline) || (ownedId && JSON.stringify(now.filter(block => block.id !== ownedId)) === JSON.stringify(baseline));
        if (!allowed) throw new Error('系统页面当前区块与运行前快照不符，拒绝恢复');
      }
    } else {
      const registryFile = this.ownershipRegistry();
      let prior = null;
      try { prior = JSON.parse(await readFile(registryFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (prior && prior.run_id !== this.config.ai.runId && prior.status === 'applied') {
        if (prior.site_name !== this.config.siteName || prior.system_page_id !== identity.id || prior.system_page !== this.systemPage) throw new Error('既有组合区块所有权与当前站点或系统页不符');
        const matches = (await this.editor.describeAiBlockWrappers()).filter(item => item.identity.id === prior.identity.id);
        if (matches.length !== 1) throw new Error('上轮组合区块所有权未唯一匹配，停止运行前替换');
        const removal = await this.editor.deleteAiBlock({ identity: prior.identity, apply: true });
        if (!removal.applied) throw new Error('上轮组合区块删除未确认');
        await this.editor.savePage(); prior.status = 'removed';
        await writeFile(registryFile, JSON.stringify(prior, null, 2));
      }
      const descriptor = aiPageDescriptor(this.config, 1);
      this.state = createInitialAiState(this.config, { ...descriptor, name: this.systemPage, path: `system:${this.systemPage}`, target_identity: identity });
      this.state.page.system_page_snapshot = await snapshotSystemPageBlocks(this.editor.canvasContexts());
      this.state.page.page_type = 'system';
    }
    this.page = this.state.page;
    this.page.category_routing = { category: this.categoryType, system_page: this.systemPage, rule: 'first category type in combo order' };
    this.state.status = 'running'; this.page.failure_reason = '';
    await this.persist();
    const record = this.state.types[0];
    if (record.apply_status === 'applied') {
      if (!await this.verifyEditorType(record.type)) throw new Error('已应用组合区块在系统页不存在');
    } else if (record.application_attempted) throw new Error('上次系统页应用结果不确定，拒绝重复插入');
    else if (!resume && record.generation_status !== 'pending') throw new Error('运行 ID 状态非空，禁止作为 fresh run');
    return this.state;
  }

  async recoverEditorForStatusRefresh() {
    await this.editor.page.reload({ waitUntil: 'domcontentloaded' });
    await this.editor.waitForCanvasReady(); await this.editor.openSystemPage(this.systemPage);
    const identity = await this.editor.currentPageIdentity();
    if (identity.name !== this.systemPage || identity.id !== this.page.target_identity.id) throw new Error('状态刷新后系统页身份变化');
  }

  ownershipRegistry() {
    return path.join(this.config.paths.aiLifecycleDir, 'combo-ownership', `${this.systemPage.replace(/[^A-Za-z0-9_-]/g, '-')}.json`);
  }

  async afterFinalApply(context) {
    await super.afterFinalApply(context);
    const record = context.record;
    const candidates = (await this.editor.describeAiBlockWrappers()).filter(item => item.identity.id === record.committed_block_id);
    if (candidates.length > 1) throw new Error('新插入的系统页组合区块稳定身份重复');
    // The commit observer's ID is the wrapper identity on some editor builds;
    // describeAiBlockWrappers can lag until the canvas reloads. The committed
    // ID is run-owned evidence and remains the deletion key in that case.
    const identity = candidates[0]?.identity ?? { id: record.committed_block_id };
    if (!identity.id) throw new Error('新插入的系统页组合区块没有稳定身份');
    this.state.ownership = { version: 1, site_name: this.config.siteName, site_language: this.config.siteLanguage,
      system_page: this.systemPage, system_page_id: this.page.target_identity.id, run_id: this.state.run_id,
      type: '复合区块', identity, status: 'applied', created_at: new Date().toISOString() };
    const registryFile = this.ownershipRegistry();
    await mkdir(path.dirname(registryFile), { recursive: true });
    await writeFile(registryFile, JSON.stringify(this.state.ownership, null, 2));
    await this.persist();
  }

  renderedOwnSelector() {
    const id = this.state.types[0].committed_block_id;
    if (!/^[A-Za-z0-9_-]+$/.test(id || '')) throw new Error('组合区块缺少安全的稳定 ID');
    const suffix = id.replace(/^siteblocks-setting-wrap-/, '');
    return `#${id}, .siteblocks-px2-${suffix}, [data-px2-page-id="${suffix}"]`;
  }

  async verifyPreview() {
    const context = this.editor.page.context(), before = new Set(context.pages());
    await this.editor.page.locator('.clickToPreview').first().click();
    let preview;
    const deadline = Date.now() + this.config.timeouts.blockRenderMs;
    while (Date.now() < deadline) {
      preview = context.pages().find(page => !before.has(page) && !page.isClosed());
      if (preview) break;
      await this.editor.page.waitForTimeout(250);
    }
    if (!preview) throw new Error('组合区块预览窗口未打开');
    try {
      while (Date.now() < deadline) {
        for (const frame of preview.frames()) {
          const own = frame.locator(this.renderedOwnSelector()).first();
          if (!await own.isVisible().catch(() => false)) continue;
          const url = new URL(frame.url());
          if (!url.pathname.endsWith('.html') || /\/phoenix/.test(url.pathname)) continue;
          this.page.publicUrl = new URL(url.pathname, this.config.publicBaseUrl).href;
          this.page.preview_verified = true;
          this.state.types[0].preview_verified = true;
          this.page.preview_evidence = { path: url.pathname, owned_block_visible: true };
          await this.persist(); return { verified: true, url: preview.url() };
        }
        await preview.waitForTimeout(500);
      }
      throw new Error('预览中未检测到本轮组合区块或无法确认本站页面路径');
    } finally { await preview.close().catch(() => {}); }
  }

  async verifyPublished() {
    if (!this.page.preview_evidence?.path) throw new Error('发布前未确认目标系统页公开路径');
    const page = await this.editor.page.context().newPage();
    try {
      await page.waitForTimeout(this.config.ai.publishInitialWaitMs);
      const deadline = Date.now() + this.config.ai.publishTimeoutMs;
      while (Date.now() < deadline) {
        await page.goto(this.page.publicUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        for (const frame of page.frames()) {
          const own = frame.locator(this.renderedOwnSelector()).first();
          if (!await own.isVisible().catch(() => false)) continue;
          const content = await own.evaluate(node => ({ text: (node.innerText || '').trim().length,
            images: [...node.querySelectorAll('img')].filter(img => img.complete && img.naturalWidth > 0).length }));
          if (!content.text && !content.images) continue;
          this.page.published_verified = true; this.state.types[0].published_verified = true;
          this.page.public_evidence = { owned_block_visible: true, ...content };
          await this.persist(); return { verified: true, url: this.page.publicUrl };
        }
        await page.waitForTimeout(this.config.ai.publishPollIntervalMs);
      }
      throw new Error('发布等待超时：公开页未显示本轮唯一组合区块');
    } finally { await page.close().catch(() => {}); }
  }

  async runUnpublished(options = {}) { return this.runRegression({ ...options, publish: false }); }

  async runRegression({ resume = false, publish = true } = {}) {
    let state;
    try {
      state = await this.run({ maxTypes: 1, resume, publish: false });
      const record = state.types[0];
      if (!state.page.saved || record.apply_status !== 'applied' || !record.committed_block_id) throw new Error('组合区块未确认保存及应用');
      await this.editor.page.reload({ waitUntil: 'domcontentloaded' });
      await this.editor.waitForCanvasReady(); await this.editor.openSystemPage(this.systemPage);
      const identity = await this.editor.currentPageIdentity();
      if (identity.name !== this.systemPage || identity.id !== this.page.target_identity.id) throw new Error('保存后系统页身份变化');
      if (!await this.verifyEditorType(record.type)) throw new Error('保存并重开后组合区块缺失');
      record.combo_reopen_verified = true;
      record.editor_verified = true; state.page.editor_verified = true;
      const evidence = { checked_types: [], matches: {} };
      for (const type of this.config.ai.compositeRegression.dynamicTypes) {
        const needle = comboSubblockPattern(type);
        let found = 0;
        for (const frame of this.editor.canvasContexts()) {
          const block = frame.locator(`#${record.committed_block_id}`);
          found += await block.locator('*').evaluateAll((nodes, source) => {
            const re = new RegExp(source, 'i');
            return nodes.filter(node => re.test(`${node.className || ''} ${node.getAttribute('data-type') || ''} ${node.getAttribute('data-component') || ''} ${node.getAttribute('data-module') || ''}`) && node.getClientRects().length > 0).length;
          }, needle.source).catch(() => 0);
        }
        evidence.checked_types.push(type); evidence.matches[type] = { visible_dom_matches: found, selector_hint: needle.source };
        if (!found) throw new Error(`组合区块中未发现可见的 ${type} DOM 特征`);
      }
      record.combo_subblock_dom = evidence;
      state.page.persisted_verified = true;
      if (state.ownership?.identity?.id !== record.committed_block_id) throw new Error('本轮组合区块所有权身份与应用记录不一致');
      await this.persist();
      if (publish) {
        if (!state.page.published_verified) {
          await this.editor.publishSite();
          await this.verifyPublished();
        }
        const moduleId = { Products: 'prod', News: 'article', 'Video List': 'video', Gallery: 'gallery', Download: 'download', FAQ: 'faq' }[this.systemPage];
        const linkage = await new ComboCategoryLinkage(this.editor, this.config, state, moduleId, () => this.persist()).run();
        if (linkage.status !== 'passed') throw new Error('组合分类数据联动未通过：' + (linkage.catalog.failure_reason || linkage.preview.failure_reason || linkage.public.failure_reason));
        state.combo_assertions_status = 'PASS'; state.combo_preview_status = 'passed'; state.combo_overall = 'PASS';
        state.page.publish_status = 'passed'; state.status = 'passed';
        await this.persist(); return state;
      }
      const deleted = await this.editor.deleteAiBlock({ identity: state.ownership.identity, apply: true });
      if (!deleted.applied) throw new Error('本轮系统页组合区块删除未确认');
      await this.editor.savePage();
      await this.editor.page.reload({ waitUntil: 'domcontentloaded' }); await this.editor.waitForCanvasReady(); await this.editor.openSystemPage(this.systemPage);
      const afterIdentity = await this.editor.currentPageIdentity();
      if (afterIdentity.name !== this.systemPage || afterIdentity.id !== identity.id) throw new Error('清理后系统页身份变化');
      const after = await snapshotSystemPageBlocks(this.editor.canvasContexts());
      assertSystemPageRestored(this.page.system_page_snapshot, after);
      state.page.restored_snapshot = after; state.page.restored = true; state.ownership.status = 'removed'; state.ownership.removed_at = new Date().toISOString();
      await writeFile(this.ownershipRegistry(), JSON.stringify(state.ownership, null, 2));
      state.combo_assertions_status = 'PASS';
      state.combo_preview_status = state.page.preview_verified ? 'passed' : 'blocked-environment';
      state.combo_overall = state.combo_preview_status === 'blocked-environment' ? 'PASS (preview env-blocked)' : 'PASS';
      state.page.publish_status = 'not-applicable; no publishing performed'; state.status = 'passed';
      await this.persist();
      return state;
    } catch (error) {
      if (!publish && this.state?.ownership?.identity?.id && this.state.ownership.status !== 'removed') {
        try {
          const identity = await this.editor.currentPageIdentity();
          if (identity.name === this.systemPage && identity.id === this.page.target_identity.id) {
            const candidates = await this.editor.describeAiBlockWrappers();
            if (candidates.filter(item => item.identity.id === this.state.ownership.identity.id).length === 1) {
              await this.editor.deleteAiBlock({ identity: this.state.ownership.identity, apply: true }); await this.editor.savePage();
              await this.editor.page.reload({ waitUntil: 'domcontentloaded' }); await this.editor.waitForCanvasReady(); await this.editor.openSystemPage(this.systemPage);
              const after = await snapshotSystemPageBlocks(this.editor.canvasContexts()); assertSystemPageRestored(this.page.system_page_snapshot, after);
              this.page.restored = true; this.state.ownership.status = 'removed';
            }
          }
        } catch (cleanupError) { this.page.restore_failure = cleanupError.message; }
      }
      if (this.state) { this.state.combo_assertions_status = 'FAIL'; this.state.combo_preview_status = this.page.preview_verified ? 'passed' : 'blocked-environment'; this.state.combo_overall = 'FAIL'; this.page.failure_reason = error.message; await this.persist().catch(() => {}); }
      throw error;
    }
  }
}
