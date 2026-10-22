import { measuredCost } from "./ai-mode-points-state.mjs";

export function parseAvailablePoints(text) {
  const normalized = String(text ?? "").replace(/,/g, "");
  const match = normalized.match(/(?:可用\s*)?([0-9]+(?:\.[0-9]+)?)\s*(?:\/|点\s*\/\s*总计)/);
  if (!match) throw new Error(`无法解析 MoliAI 可用点数：${String(text ?? "").slice(0, 100)}`);
  return Number(match[1]);
}

export class AiDialogPointsReader {
  constructor(config) {
    this.config = config;
  }

  async read(frame) {
    const gear = frame.locator("button.ai-settings-trigger");
    const panel = frame.locator(".ai-settings-panel");
    try {
      await gear.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
      if (await panel.isVisible().catch(() => false)) await gear.click();
      await panel.waitFor({ state: "hidden", timeout: this.config.timeouts.actionMs });
      await gear.click();
      await panel.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
      const detail = panel.locator(".moli-credit-detail");
      await detail.waitFor({ state: "visible", timeout: this.config.timeouts.actionMs });
      return parseAvailablePoints(await detail.innerText());
    } catch (error) {
      if (/无法解析 MoliAI 可用点数/.test(error.message)) throw error;
      throw new Error("AI 弹窗设置面板的可用点数读取失败，请检查登录态或点数面板");
    } finally {
      if (await panel.isVisible().catch(() => false)) {
        try {
          await gear.click();
          await panel.waitFor({ state: "hidden", timeout: this.config.timeouts.actionMs });
        } catch {
          throw new Error("AI 弹窗设置面板无法关闭，已停止生成以避免误操作");
        }
      }
    }
  }

  async waitForCharge(frame, before, expectedCost, { timeoutMs, intervalMs }) {
    const deadline = Date.now() + timeoutMs;
    let after = before;
    while (Date.now() < deadline) {
      after = await this.read(frame);
      if (measuredCost(before, after) === expectedCost) return after;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return after;
  }
}
