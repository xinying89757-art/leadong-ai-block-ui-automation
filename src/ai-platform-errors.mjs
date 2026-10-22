// Read explicit business alerts before falling back to locator timeouts.
export async function assertPageCapacityAvailable(page) {
  const limit = page.getByText(/(?:页面数量|添加的页面数量).*(?:最大限制|上限)|页面.*数量.*已(?:经)?达到/).first();
  if (!(await limit.isVisible().catch(() => false))) return;
  const error = new Error('站点页面数量已达到最大限制，无法新建测试页；请释放页面名额或提高上限，不自动删除旧页面');
  error.code = 'PAGE_CAPACITY_LIMIT';
  throw error;
}
