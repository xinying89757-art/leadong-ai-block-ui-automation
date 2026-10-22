/** Exact host allowlist. Empty means no network behavior changes. */
export function parseHttpsUpgradeHosts(value = []) {
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(parts.map(item => {
    if (typeof item !== 'string') throw new TypeError('HTTPS upgrade hosts must be host names');
    const host = item.trim().toLowerCase();
    if (!host) return '';
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/.test(host)) throw new TypeError('HTTPS upgrade hosts must contain only host names, without scheme or path');
    return host;
  }).filter(Boolean))];
}
export function httpsUpgradeHosts(config = {}, env = process.env) {
  return parseHttpsUpgradeHosts(env.LEADONG_HTTPS_UPGRADE_HOSTS === undefined ? config.network?.httpsUpgradeHosts ?? [] : env.LEADONG_HTTPS_UPGRADE_HOSTS);
}
export function upgradeHttpUrl(value, hosts = []) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && hosts.includes(url.host.toLowerCase())) { url.protocol = 'https:'; return url.href; }
  } catch { /* Relative Location values do not need upgrading. */ }
  return value;
}
export function rewriteUpgradeLocation(headers, hosts) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, name.toLowerCase() === 'location' ? upgradeHttpUrl(value, hosts) : value]));
}
export function previewFailureStatus(error, urls = []) {
  return urls.some(url => /^http:\/\//i.test(url ?? '')) && /ERR_CONNECTION_TIMED_OUT|timeout|timed out/i.test(error.message)
    ? 'blocked-environment' : 'failed';
}
export async function installHttpsUpgrade(context, hosts) {
  if (!hosts.length) return;
  // Context routing also covers iframe and first popup navigation requests.
  await context.route(url => url.protocol === 'http:' && hosts.includes(url.host.toLowerCase()), async route => {
    const request = route.request();
    const response = await context.request.fetch(upgradeHttpUrl(request.url(), hosts), {
      method: request.method(), headers: await request.allHeaders(), data: request.postDataBuffer() ?? undefined,
      maxRedirects: 0, timeout: 60000, failOnStatusCode: false,
    });
    try {
      await route.fulfill({ response, status: response.status(), headers: rewriteUpgradeLocation(response.headers(), hosts), body: await response.body() });
    } finally { await response.dispose(); }
  });
}
