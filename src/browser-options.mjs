function parseBoolean(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1"].includes(normalized)) return true;
  if (["false", "0"].includes(normalized)) return false;
  throw new TypeError(`${name} must be true, false, 1, or 0`);
}

import { resolveSetting } from "./config.mjs";

function parseSlowMo(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const milliseconds = Number(value);
  if (!Number.isInteger(milliseconds) || milliseconds < 0) throw new TypeError("LEADONG_SLOW_MO must be a non-negative integer");
  return milliseconds;
}

/** Resolve Playwright launch options from config and LEADONG_* environment overrides. */
export function browserLaunchOptions(config = {}, overrides = {}, env = process.env) {
  const browser = config.browser ?? config;
  const isCi = Boolean(env.CI) && String(env.CI).toLowerCase() !== "false";
  const channelValue = resolveSetting("LEADONG_BROWSER_CHANNEL", undefined, env, { allowEmpty: true });
  const channel = channelValue === undefined ? (isCi ? "" : browser.channel ?? "chrome") : channelValue.trim();
  const headless = parseBoolean(resolveSetting("LEADONG_HEADLESS", undefined, env), "LEADONG_HEADLESS") ?? overrides.headless ?? (isCi ? true : browser.headless ?? false);
  const slowMo = parseSlowMo(resolveSetting("LEADONG_SLOW_MO", undefined, env)) ?? overrides.slowMo ?? browser.slowMo ?? 0;
  const options = { headless, slowMo };
  if (channel && channel.toLowerCase() !== "chromium") options.channel = channel;
  return options;
}
