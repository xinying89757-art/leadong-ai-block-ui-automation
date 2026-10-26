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
    await this.persist();
  }

  async runUnpublished({ resume = false } = {}) {
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
      const deleted = await this.editor.deleteAiBlock({ identity: state.ownership.identity, apply: true });
      if (!deleted.applied) throw new Error('本轮系统页组合区块删除未确认');
      await this.editor.savePage();
      await this.editor.page.reload({ waitUntil: 'domcontentloaded' }); await this.editor.waitForCanvasReady(); await this.editor.openSystemPage(this.systemPage);
      const afterIdentity = await this.editor.currentPageIdentity();
      if (afterIdentity.name !== this.systemPage || afterIdentity.id !== identity.id) throw new Error('清理后系统页身份变化');
      const after = await snapshotSystemPageBlocks(this.editor.canvasContexts());
      assertSystemPageRestored(this.page.system_page_snapshot, after);
      state.page.restored_snapshot = after; state.page.restored = true; state.ownership.status = 'removed'; state.ownership.removed_at = new Date().toISOString();
      state.combo_assertions_status = 'PASS';
      state.combo_preview_status = state.page.preview_verified ? 'passed' : 'blocked-environment';
      state.combo_overall = state.combo_preview_status === 'blocked-environment' ? 'PASS (preview env-blocked)' : 'PASS';
      state.page.publish_status = 'not-applicable; no publishing performed'; state.status = 'passed';
      await this.persist();
      return state;
    } catch (error) {
      if (this.state?.ownership?.identity?.id && this.state.ownership.status !== 'removed') {
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
