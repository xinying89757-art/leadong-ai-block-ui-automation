// Only page identity and business outcomes are retained; never form tokens.
export function pagePath(value = '') {
  try { return new URL(value, 'https://local.invalid').pathname.replace(/\/$/, '') || '/'; }
  catch { return ''; }
}

export function pageCreationRequest(body = '') {
  let values;
  try { values = JSON.parse(body); } catch { values = Object.fromEntries(new URLSearchParams(body)); }
  return { name: values['page.pageTitle'] ?? values.pageTitle ?? values.page?.pageTitle ?? '',
    path: values['page.pageUrl'] ?? values.pageUrl ?? values.page?.pageUrl ?? '' };
}

export function pageCreationResult(payload, httpOk, expectedName = '') {
  if (!httpOk) throw new Error('页面创建失败：接口请求未成功');
  const value = typeof payload === 'string' ? (() => { try { return JSON.parse(payload); } catch { return payload; } })() : payload;
  const objects = [value, value?.success, value?.data, value?.result, value?.page].filter(item => item && typeof item === 'object');
  if (value && typeof value === 'object' && (value.error || value.failure || value.fail)) throw new Error('页面创建失败：平台返回业务失败');
  for (const item of objects) {
    if (item.success === false || item.ok === false || item.result === false ||
      /^(fail(?:ed|ure)?|error)$/i.test(String(item.status ?? item.result ?? '')) ||
      (item.code !== undefined && ![0, 200, '0', '200', 'SUCCESS', 'success'].includes(item.code))) {
      throw new Error('页面创建失败：平台返回业务失败');
    }
  }
  const id = objects.map(item => item.pageId ?? item.page?.pageId ?? item.page?.id ?? item.id).find(item => typeof item === 'string' && /^[A-Za-z0-9_-]+$/.test(item)) || '';
  const name = objects.map(item => item.pageTitle ?? item.page?.pageTitle).find(item => typeof item === 'string');
  if (expectedName && name !== undefined && name !== expectedName) throw new Error('页面创建失败：业务回执的页面名称不匹配');
  const positive = id || objects.some(item => item.success === true || item.ok === true ||
    [0, 200, '0', '200'].includes(item.code) || /^(success|ok)$/i.test(String(item.status ?? item.result ?? ''))) ||
    typeof value === 'string' && /^(success|ok|true)$/i.test(value.trim());
  if (!positive) throw new Error('页面创建结果待确认：业务回执无法识别，禁止再次提交创建');
  return { id, business_status: 'succeeded' };
}

export function comparePageIdentity(expected, actual) {
  if (expected.id && actual.id) return { matched: expected.id === actual.id,
    mismatch: expected.id !== actual.id, basis: 'page-id', staleLabel: expected.id === actual.id && expected.name !== actual.name };
  if (!actual.id) return { matched: false, mismatch: false, basis: 'unconfirmed' };
  return { matched: actual.name === expected.name && (!expected.path || !actual.path || pagePath(actual.path) === pagePath(expected.path)),
    mismatch: false, basis: 'exact-name-and-readable-id' };
}
