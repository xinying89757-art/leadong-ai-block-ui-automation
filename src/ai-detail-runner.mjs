import path from "node:path";
import { AiBlockAutomation } from "./ai-runner.mjs";
import {
  AiStateStore,
  assertAiStateCompatible,
  createInitialAiState,
  markTypeFailed,
} from "./ai-state.mjs";
import { assertTargetDetailUrl } from "./ai-detail-content.mjs";
import {
  addedDetailCandidates,
  assertDetailOwnershipCompatible,
  createDetailOwnership,
  identityKey,
  readDetailOwnership,
  selectOwnedDetailCandidate,
  writeDetailOwnership,
} from "./ai-detail-ownership.mjs";

export function detailStatePath(config, detail) {
  return path.join(config.paths.aiDetailStateDir, `${detail.moduleId}.json`);
}

export function detailRunConfig(config, detail) {
  return {
    ...config,
    ai: { ...config.ai, blocksPerPage: 1, types: [detail.type], followupPages: [] },
    paths: { ...config.paths, aiStateFile: detailStatePath(config, detail) },
  };
}

export function detailEvidenceRequirements(type) {
  return {
    "产品详情": { media: "image", action: /inquiry|contact|quote/i },
    // Existing article records on this site may legitimately have no cover
    // image; the title/body binding is the reliable content assertion.
    "文章详情": {},
    "图册详情": { media: "image" },
    "视频详情": { media: "video" },
  }[type];
}

async function visibleMarker(scope, marker) {
  const locator = scope.getByText(marker, { exact: true }).first();
  return await locator.isVisible().catch(() => false) ? locator : null;
}

export class AiDetailAutomation extends AiBlockAutomation {
  constructor(editor, config, detail, item, store = new AiStateStore(detailStatePath(config, detail))) {
    const scoped = detailRunConfig(config, detail);
    super(editor, scoped, store, 1);
    this.detail = detail;
    this.item = item;
  }

  async initialize() {
    const existing = await this.store.load();
    if (existing) {
      const migrated = assertAiStateCompatible(existing, this.config, "ai-detail");
      this.state = existing;
      if (migrated) await this.store.save(this.state);
    } else {
      if (!this.item) throw new Error(`${this.detail.type} 尚无本站内容样本`);
      const publicUrl = assertTargetDetailUrl(this.item.url, this.config.publicBaseUrl);
      this.state = createInitialAiState(this.config, {
        number: 0,
        name: this.detail.systemPage,
        path: `system:${this.detail.systemPage}`,
        publicUrl,
      });
      this.state.mode = "ai-detail";
      this.state.page.content = { ...this.item, url: publicUrl };
      this.state.page.publish_status = "pending";
      this.state.page.pre_run_cleanup = {
        status: "pending",
        previous_run_id: "",
        deleted_identity: null,
        failure_reason: "",
        completed_at: "",
      };
      await this.persist();
    }
    if (this.state.mode !== "ai-detail" || this.state.page.name !== this.detail.systemPage) {
      throw new Error(`${this.detail.type} 状态文件与系统页配置不匹配`);
    }
    assertTargetDetailUrl(this.state.page.publicUrl, this.config.publicBaseUrl);
    this.page = this.state.page;
    this.state.page.pre_run_cleanup ??= {
      status: "pending",
      previous_run_id: "",
      deleted_identity: null,
      failure_reason: "",
      completed_at: "",
    };
    if (this.state.page.published_verified && this.state.types[0]?.failure_reason) {
      this.state.types[0].failure_reason = "";
      await this.persist();
    }
    await this.editor.openSystemPage(this.detail.systemPage);
    if (this.state.types[0].apply_status !== "applied" && this.state.page.pre_run_cleanup.status !== "succeeded") {
      await this.cleanupPreviousRunBlock();
    }
    const marker = await this.findEditorMarker();
    const block = await this.findEditorBlock();
    const applied = this.state.types[0].apply_status === "applied";
    if ((marker || block) && !applied) {
      throw new Error(`${this.detail.systemPage} 已显示本轮 AI 标记，但状态未确认应用；请人工检查以免重复插入`);
    }
    if (!marker && !block && applied) {
      if (this.state.types[0].editor_verified && !this.state.types[0].recovery_required) {
        // Some system pages expose only the base canvas after a reload, while
        // the previous run already captured a successful apply response and
        // editor verification. Continue to preview/publish without inserting
        // a duplicate block.
      } else {
        throw new Error(`${this.detail.systemPage} 状态为已应用，但编辑器未找到本轮 AI 区块`);
      }
    }
    if (applied && (marker || block) && this.state.types[0].recovery_required) {
      this.state.types[0].recovery_required = false;
      this.state.types[0].editor_verified = true;
      this.state.page.editor_verified = true;
      await this.persist();
    }
    return this.state;
  }

  async describeCurrentBlocks() {
    const described = await this.editor.describeAiBlockWrappers();
    const unique = [];
    for (const item of described) {
      const key = identityKey(item.identity);
      const duplicate = key && unique.some((known) => identityKey(known.identity) === key);
      if (!duplicate) unique.push(item);
    }
    return unique;
  }

  async cleanupPreviousRunBlock() {
    const cleanup = this.state.page.pre_run_cleanup;
    cleanup.status = "running";
    cleanup.failure_reason = "";
    await this.persist();
    try {
      let ownership = assertDetailOwnershipCompatible(
        await readDetailOwnership(this.config, this.detail),
        this.config,
        this.detail,
      );
      const current = await this.describeCurrentBlocks();
      if (!ownership && current.length > 0) ownership = await this.bootstrapLegacyOwnership(current);
      if (!ownership) {
        if (current.length > 0) {
          throw new Error(`${this.detail.systemPage} 存在 ${current.length} 个无法确认归属的 AI 区块，拒绝新增详情区块`);
        }
      } else {
        const matches = selectOwnedDetailCandidate(current, ownership);
        if (matches.length > 1) throw new Error(`${this.detail.systemPage} 匹配到多个旧详情区块，拒绝删除`);
        if (matches.length === 0 && current.length > 0) {
          throw new Error(`${this.detail.systemPage} 未找到所有权记录对应区块，但存在其他 AI 区块，拒绝继续`);
        }
        if (matches.length === 1) {
          const result = await this.editor.deleteAiBlock({ identity: ownership.identity, apply: true });
          if (!result.applied) throw new Error(`${this.detail.type} 旧区块删除未确认`);
          await this.editor.savePage();
          cleanup.previous_run_id = ownership.run_id;
          cleanup.deleted_identity = ownership.identity;
          if (selectOwnedDetailCandidate(await this.describeCurrentBlocks(), ownership).length !== 0) {
            throw new Error(`${this.detail.type} 旧区块删除后仍存在`);
          }
        }
      }
      cleanup.status = "succeeded";
      cleanup.completed_at = new Date().toISOString();
      this.state.page.baseline_block_identities = (await this.describeCurrentBlocks()).map((item) => item.identity);
      await this.persist();
    } catch (error) {
      cleanup.status = "failed";
      cleanup.failure_reason = error.message;
      await this.persist();
      throw error;
    }
  }

  async bootstrapLegacyOwnership(current) {
    const legacyDir = this.config.paths.aiDetailLegacyStateDir;
    if (!legacyDir) return null;
    const legacy = await new AiStateStore(path.join(legacyDir, `${this.detail.moduleId}.json`)).load();
    const record = legacy?.types?.find((item) => item.type === this.detail.type);
    if (legacy?.mode !== "ai-detail" || legacy.site_name !== this.config.siteName ||
        legacy.page?.name !== this.detail.systemPage || record?.apply_status !== "applied") return null;
    const contentName = legacy.page?.content?.name || "";
    const matches = current.filter((item) =>
      item.identity.text.includes(this.detail.marker) || (contentName && item.identity.text.includes(contentName))
    );
    if (matches.length !== 1) return null;
    const ownership = createDetailOwnership(
      this.config,
      this.detail,
      legacy.run_id || "legacy",
      matches[0].identity,
      "legacy-adopted",
    );
    return writeDetailOwnership(this.config, this.detail, ownership);
  }

  async registerAppliedOwnership() {
    const before = (this.state.page.baseline_block_identities ?? []).map((identity) => ({ identity }));
    const after = await this.describeCurrentBlocks();
    const added = addedDetailCandidates(before, after);
    if (added.length !== 1) {
      throw new Error(`${this.detail.type} 应用后新增区块数量为 ${added.length}，无法建立唯一所有权`);
    }
    const ownership = createDetailOwnership(
      this.config,
      this.detail,
      this.config.ai.runId,
      added[0].identity,
    );
    this.state.types[0].block_identity = added[0].identity;
    await writeDetailOwnership(this.config, this.detail, ownership);
    await this.persist();
  }

  async findEditorMarker() {
    for (const frame of this.editor.canvasContexts()) {
      const marker = await visibleMarker(frame, this.detail.marker);
      if (marker) return marker;
    }
    return null;
  }

  async findEditorBlock() {
    for (const frame of this.editor.canvasContexts()) {
      const blocks = frame.locator(this.config.selectors.aiGeneratedBlockSelector);
      const count = await blocks.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const block = blocks.nth(index);
        // The editor keeps hidden AI templates in the canvas DOM. A raw
        // count therefore reports a false existing detail block immediately
        // after the old owned block was removed. Only visible blocks are
        // evidence that the system page already contains a detail block.
        if (await block.isVisible().catch(() => false)) return block;
      }
    }
    return null;
  }

  async verifyEditorType() {
    return Boolean(await this.findEditorMarker() || await this.findEditorBlock());
  }

  async verifyPreview() {
    const preview = this.editor.page.locator(".clickToPreview").first();
    await preview.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
    const before = new Set(this.editor.page.context().pages());
    const popupPromise = this.editor.page.context().waitForEvent("page", { timeout: 10_000 }).catch(() => null);
    await preview.click();
    const previewPage = await popupPromise
      ?? [...this.editor.page.context().pages()].find((page) => !before.has(page));
    if (!previewPage) throw new Error(`${this.detail.systemPage} 点击预览后没有打开页面`);
    const findEvidence = async (candidate) => {
      for (const frame of candidate.frames()) {
        const marker = await visibleMarker(frame, this.detail.marker);
        if (marker) return marker;
        // Generated markup can normalize or omit the exact prompt marker.
        // The bound record title is the second, independent signal that the
        // detail block rendered on the preview page.
        const title = frame.getByText(this.page.content.name, { exact: false }).first();
        if (await title.isVisible().catch(() => false)) {
          const wrapper = title.locator("xpath=ancestor::*[contains(@class,'phoenix2-block-wrap') or contains(@class,'ai-generated-block') or @data-px2-page-id][1]");
          if (await wrapper.count().catch(() => 0)) return title;
        }
        // Detail templates expose stable semantic title/media classes even
        // when the visible text is rendered inside a client-side widget.
        const semantic = frame.locator(".articleTitle, .galleryName, .video-title, .videoTitle").filter({ hasText: this.page.content.name }).first();
        if (await semantic.isVisible().catch(() => false)) return semantic;
      }
      return null;
    };
    let fallbackPage = null;
    try {
      await previewPage.waitForLoadState("domcontentloaded").catch(() => {});
      // The preview shell opens before its public-detail iframe is populated.
      // Wait for that asynchronous frame instead of inspecting an empty shell.
      const previewDeadline = Date.now() + this.config.timeouts.blockRenderMs;
      while (Date.now() < previewDeadline) {
        if (previewPage.frames().some((frame) => frame.url().includes("preview.leadong.com"))) break;
        await previewPage.waitForTimeout(250);
      }
      let marker = await findEvidence(previewPage);
      // The generic system-page preview sometimes opens at `/` for video
      // and other detail templates because no record context is attached to
      // the preview shell. Re-open the same record path on the site's preview
      // host so the preview assertion still exercises the actual detail page.
      if (!marker && this.page.publicUrl) {
        const target = new URL(this.page.publicUrl);
        const sitePrefix = target.hostname.split(".")[0];
        fallbackPage = await this.editor.page.context().newPage();
        await fallbackPage.goto(
          `http://${sitePrefix}.preview.leadong.com${target.pathname}${target.search}`,
          { waitUntil: "domcontentloaded" },
        ).catch(() => {});
        await fallbackPage.waitForTimeout(1500);
        marker = await findEvidence(fallbackPage);
        if (marker && !previewPage.isClosed()) await previewPage.close();
      }
      if (!marker) throw new Error(`${this.detail.systemPage} 预览页没有显示 AI 详情区块或绑定内容标题 ${this.page.content.name}`);
      this.state.page.preview_verified = true;
      this.state.types[0].preview_verified = true;
      this.state.types[0].failure_reason = "";
      await this.persist();
      return { url: previewPage.url(), verified: true };
    } finally {
      if (!previewPage.isClosed()) await previewPage.close();
      if (fallbackPage && !fallbackPage.isClosed()) await fallbackPage.close();
    }
  }

  async inspectPublicDetail(publicPage) {
    let marker = await visibleMarker(publicPage, this.detail.marker);
    if (!marker) {
      const title = publicPage.getByText(this.page.content.name, { exact: false }).first();
      if (await title.isVisible().catch(() => false)) marker = title;
    }
    if (!marker) return { verified: false, reason: "AI 区块标记或绑定内容标题未出现" };
    let block = marker.locator("xpath=ancestor::*[contains(@class,'phoenix2-block-wrap') or contains(@class,'ai-generated-block') or @data-px2-page-id][1]");
    if (!(await block.count())) {
      block = publicPage.locator(".phoenix2-block-wrap, .ai-generated-block, [data-px2-page-id]").filter({ hasText: this.page.content.name }).first();
    }
    if (!(await block.count())) return { verified: false, reason: "无法定位新增 AI 区块根节点" };
    const text = await block.innerText();
    const name = this.page.content.name;
    if (!text.includes(name)) return { verified: false, reason: `AI 区块内未显示内容标题 ${name}` };
    const requirements = detailEvidenceRequirements(this.detail.type);
    if (requirements.media === "image" && await block.locator("img").count() === 0) {
      return { verified: false, reason: "AI 区块内未显示内容图片" };
    }
    if (requirements.media === "video" && await block.locator("video, iframe, [class*='video-player'], [class*='videoPlayer']").count() === 0) {
      return { verified: false, reason: "AI 区块内未显示视频播放器" };
    }
    if (requirements.action && !requirements.action.test(text)) {
      return { verified: false, reason: "AI 产品详情区块内未显示询盘入口" };
    }
    return { verified: true, title: name, marker: this.detail.marker };
  }

  async verifyPublished() {
    const publicPage = await this.editor.page.context().newPage();
    const target = this.page.publicUrl;
    const deadline = Date.now() + this.aiConfig.publishTimeoutMs;
    let last = { verified: false, reason: "尚未访问前台" };
    try {
      await publicPage.waitForTimeout(this.aiConfig.publishInitialWaitMs);
      while (Date.now() < deadline) {
        try {
          await publicPage.goto(target, { waitUntil: "domcontentloaded" });
          assertTargetDetailUrl(publicPage.url(), this.config.publicBaseUrl);
          last = await this.inspectPublicDetail(publicPage);
          if (last.verified) {
            this.state.page.published_verified = true;
            this.state.page.publish_status = "verified";
            this.state.page.publish_failure_reason = "";
            this.state.types[0].published_verified = true;
            this.state.types[0].failure_reason = "";
            const ownership = await readDetailOwnership(this.config, this.detail);
            if (ownership && ownership.run_id === (this.config.ai.runId || "")) {
              ownership.status = "retained";
              ownership.published_verified = true;
              ownership.published_verified_at = new Date().toISOString();
              await writeDetailOwnership(this.config, this.detail, ownership);
            }
            await this.persist();
            return { url: publicPage.url(), ...last };
          }
        } catch (error) {
          last = { verified: false, reason: error.message };
        }
        await publicPage.waitForTimeout(this.aiConfig.publishPollIntervalMs);
      }
      this.state.page.publish_failure_reason = `发布轮询超时：${target}；${last.reason}`;
      await this.persist();
      throw new Error(this.state.page.publish_failure_reason);
    } finally {
      await publicPage.close().catch(() => {});
    }
  }

  async run() {
    await this.initialize();
    if (this.state.page.published_verified) return this.state;
    const record = this.state.types[0];
    if (record.recovery_required) {
      throw new Error(`${this.detail.type} 生成或应用状态不确定；请人工检查系统页后再恢复`);
    }
    if (record.apply_status !== "applied") {
      try {
        await this.generateAndApply(record);
        await this.registerAppliedOwnership();
      } catch (error) {
        markTypeFailed(record, error);
        await this.persist();
        const frame = this.aiFrame();
        const close = frame?.locator(".close-icon-container").first();
        if (close && await close.isVisible().catch(() => false)) await close.click().catch(() => {});
        throw error;
      }
    }
    try {
      this.state.page.editor_verified = record.editor_verified;
      if (!this.state.page.saved) {
        await this.editor.savePage();
        this.state.page.saved = true;
        await this.persist();
      }
      if (!this.state.page.preview_verified) await this.verifyPreview();
      if (this.state.page.publish_status === "running") {
        throw new Error(`${this.detail.type} 上次发布请求结果不确定；请人工检查后恢复`);
      }
      if (this.state.page.publish_status !== "accepted") {
        this.state.page.publish_status = "running";
        await this.persist();
        await this.editor.publishSite();
        this.state.page.publish_status = "accepted";
        await this.persist();
      }
      await this.verifyPublished();
    } catch (error) {
      // Keep generation/apply evidence intact while recording the exact
      // downstream preview/publish failure for ai:status and resume.
      record.failure_reason = error instanceof Error ? error.message : String(error);
      await this.persist();
      throw error;
    }
    return this.state;
  }
}

export async function cleanupOwnedDetail(editor, config, detail, { publish = true } = {}) {
  await editor.openSystemPage(detail.systemPage);
  const ownership = assertDetailOwnershipCompatible(await readDetailOwnership(config, detail), config, detail);
  if (!ownership) throw new Error(`${detail.type} 没有可清理的自动化所有权记录`);
  const current = await editor.describeAiBlockWrappers();
  const matches = selectOwnedDetailCandidate(current, ownership);
  if (matches.length !== 1) throw new Error(`${detail.type} 所有权区块匹配数量为 ${matches.length}，拒绝删除`);
  const result = await editor.deleteAiBlock({ identity: ownership.identity, apply: true });
  if (!result.applied) throw new Error(`${detail.type} 区块删除未确认`);
  await editor.savePage();
  if (publish) await editor.publishSite();
  ownership.status = "deleted";
  ownership.deleted_at = new Date().toISOString();
  await writeDetailOwnership(config, detail, ownership);
  return {
    type: detail.type,
    systemPage: detail.systemPage,
    identity: ownership.identity,
    deleted: true,
    published: publish,
  };
}
