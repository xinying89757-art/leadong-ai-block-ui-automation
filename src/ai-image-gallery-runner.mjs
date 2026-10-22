import { AiPagedAutomation } from "./ai-paged-runner.mjs";

export class AiImageGalleryAutomation extends AiPagedAutomation {
  async verifyEditorType(type) {
    const committed = await super.verifyEditorType(type);
    const record = this.state.types.find(item => item.type === type);
    const id = record?.committed_block_id || "";
    const evidence = { block_id: id, unique_visible_block: false, text_length: 0, visible_image_count: 0, checked_at: new Date().toISOString() };
    if (committed && /^[a-zA-Z0-9_-]+$/.test(id)) {
      for (const frame of this.editor.canvasContexts()) {
        const block = frame.locator(`#${id}`);
        if (await block.count().catch(() => 0) !== 1 || !await block.isVisible().catch(() => false)) continue;
        evidence.unique_visible_block = true;
        evidence.text_length = (await block.innerText().catch(() => "")).trim().length;
        evidence.visible_image_count = await block.locator("img:visible").count().catch(() => 0);
        break;
      }
    }
    evidence.passed = evidence.unique_visible_block && (evidence.text_length > 0 || evidence.visible_image_count > 0);
    record.image_gallery_editor_evidence = evidence;
    await this.persist();
    return committed && evidence.passed;
  }
}
