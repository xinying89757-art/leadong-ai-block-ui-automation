function parseBoolean(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1"].includes(normalized)) return true;
  if (["false", "0"].includes(normalized)) return false;
  throw new TypeError(`${name} must be true, false, 1, or 0`);
}

function parseSlowMo(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError("AIBLOCK_SLOWMO must be a non-negative number");
  }
  return milliseconds;
}

/** Resolve Playwright launch options from config and AIBLOCK_* environment overrides. */
export function browserLaunchOptions(config = {}, overrides = {}, env = process.env) {
  const browser = config.browser ?? config;
  const configuredChannel = browser.channel ?? "chrome";
  const envChannel = env.AIBLOCK_BROWSER_CHANNEL;
  const channel = envChannel === undefined ? configuredChannel : envChannel.trim();
  const envHeadless = parseBoolean(env.AIBLOCK_HEADLESS, "AIBLOCK_HEADLESS");
  const configuredHeadless = browser.headless ?? false;
  const isCi = Boolean(env.CI) && String(env.CI).toLowerCase() !== "false";
  const headless = envHeadless ?? (overrides.headless === true ? true : (isCi ? true : configuredHeadless));
  const slowMo = parseSlowMo(env.AIBLOCK_SLOWMO) ?? overrides.slowMo ?? browser.slowMo ?? 0;
  const options = { headless, slowMo };
  // `chromium` and an empty value intentionally select Playwright's bundled browser.
  if (channel && channel.toLowerCase() !== "chromium") options.channel = channel;
  else delete options.channel;
  return options;
}
