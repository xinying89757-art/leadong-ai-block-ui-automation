/**
 * Optional Midscene.js locator fallback for controls that are difficult to
 * address through the page's custom Vue DOM.  Playwright remains responsible
 * for the click, state transition and assertion; Midscene only supplies a
 * page-level visual coordinate after the deterministic path has failed.
 */
export class MidsceneLocatorFallback {
  constructor(page, options = {}) {
    this.page = page;
    this.options = {
      enabled: options.enabled === true,
      domFastPathTimeoutMs: Number.isInteger(options.domFastPathTimeoutMs) ? options.domFastPathTimeoutMs : 2000,
      maxCallsPerSetting: Number.isInteger(options.maxCallsPerSetting) ? options.maxCallsPerSetting : 1,
      midsceneTimeoutMs: Number.isInteger(options.midsceneTimeoutMs) ? options.midsceneTimeoutMs : 20000,
    };
    this.agentFactory = options.agentFactory;
    this.agent = null;
    this.calls = new Map();
  }

  isEnabled() {
    return this.options.enabled;
  }

  async locate(key, description) {
    if (!this.options.enabled) throw new Error("Midscene 视觉兜底未启用");
    const used = this.calls.get(key) ?? 0;
    if (used >= this.options.maxCallsPerSetting) {
      throw new Error(`Midscene 设置项 ${key} 已达到调用上限`);
    }
    this.calls.set(key, used + 1);
    if (!process.env.MIDSCENE_MODEL_API_KEY) {
      throw new Error("Midscene 已启用但缺少 MIDSCENE_MODEL_API_KEY");
    }
    const started = Date.now();
    try {
      this.agent ??= await this.createAgent();
      const result = await Promise.race([
        this.agent.aiLocate(description),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Midscene 视觉定位超时")), this.options.midsceneTimeoutMs)),
      ]);
      if (!result?.center || result.center.length < 2) {
        throw new Error("Midscene 未返回有效坐标");
      }
      const dpr = Number(result.dpr ?? 1) > 0 ? Number(result.dpr ?? 1) : 1;
      const center = [Number(result.center[0]) / dpr, Number(result.center[1]) / dpr];
      const rect = result.rect
        ? {
            left: Number(result.rect.left ?? 0) / dpr,
            top: Number(result.rect.top ?? 0) / dpr,
            width: Number(result.rect.width ?? 0) / dpr,
            height: Number(result.rect.height ?? 0) / dpr,
          }
        : null;
      return {
        source: "midscene",
        duration_ms: Date.now() - started,
        center,
        rect,
        dpr,
      };
    } catch (error) {
      error.midsceneDurationMs = Date.now() - started;
      throw error;
    }
  }

  async createAgent() {
    if (this.agentFactory) return this.agentFactory(this.page);
    const { PlaywrightPageAgent } = await import("@midscene/web/playwright");
    return new PlaywrightPageAgent(this.page, { forceSameTabNavigation: true });
  }
}

export function applyMidsceneEvidence(setting, evidence) {
  setting.locator_source = evidence.source;
  setting.fallback_used = evidence.source === "midscene";
  setting.midscene_duration_ms = evidence.duration_ms ?? 0;
  setting.midscene_rect = evidence.rect ?? null;
  setting.midscene_failure_reason = "";
}

export function applyMidsceneFailure(setting, error) {
  const evidenceAlreadyRecorded = Boolean(setting.midscene_rect);
  setting.locator_source = "midscene";
  setting.fallback_used = true;
  if (!evidenceAlreadyRecorded) setting.midscene_duration_ms = Number(error?.midsceneDurationMs ?? 0);
  setting.midscene_failure_reason = String(error?.message ?? error);
}
