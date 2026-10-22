import { authConfig, isLoginPage } from "./auth.mjs";

export function assertTargetDetailUrl(url, publicBaseUrl) {
  const target = new URL(url);
  const site = new URL(publicBaseUrl);
  if (!["http:", "https:"].includes(target.protocol) || target.hostname !== site.hostname) {
    throw new Error(`前台详情地址不属于目标站点：${target.origin}`);
  }
  return target.toString();
}

export class DetailContentBrowser {
  constructor(context, config) {
    this.context = context;
    this.config = config;
    this.backendPage = null;
  }

  async open() {
    if (this.backendPage && !this.backendPage.isClosed()) return this.backendPage;
    const landing = await this.context.newPage();
    try {
      await landing.goto(authConfig(this.config).adminUrl, { waitUntil: "domcontentloaded" });
      if (await isLoginPage(landing)) throw new Error("内容管理后台登录态失效");
      const cards = landing.locator(this.config.selectors.siteCardSelector);
      const card = cards.filter({ hasText: this.config.siteName }).first();
      const deadline = Date.now() + this.config.timeouts.blockRenderMs;
      while (Date.now() < deadline && !(await card.isVisible().catch(() => false))) {
        await landing.waitForTimeout(250);
      }
      if (!(await card.isVisible().catch(() => false))) {
        throw new Error(`内容管理后台中未找到站点 ${this.config.siteName}`);
      }
      const cardText = await card.innerText();
      if (!cardText.includes(this.config.siteLanguage)) {
        throw new Error(`目标站点 ${this.config.siteName} 未匹配语言 ${this.config.siteLanguage}`);
      }
      const siteHost = new URL(this.config.publicBaseUrl).hostname;
      const siteLink = card.locator("a[href]").filter({ hasText: siteHost }).first();
      if (!(await siteLink.count())) throw new Error(`目标站点卡片缺少前台域名 ${siteHost}`);
      const content = card.getByText("内容管理", { exact: true }).first();
      if (!(await content.count())) throw new Error("目标站点卡片缺少内容管理入口");
      const popupPromise = this.context.waitForEvent("page", { timeout: this.config.timeouts.actionMs });
      await content.click();
      this.backendPage = await popupPromise;
      await this.backendPage.waitForURL((url) => url.pathname.includes("/phoenix/website"), {
        timeout: this.config.timeouts.blockRenderMs,
      });
      return this.backendPage;
    } finally {
      await landing.close().catch(() => {});
    }
  }

  async findPublishedDetail(detail) {
    const backend = await this.open();
    const moduleUrl = new URL(backend.url());
    moduleUrl.pathname = "/phoenix/website";
    moduleUrl.search = `?module=${encodeURIComponent(detail.moduleId)}`;
    await backend.goto(moduleUrl.toString(), { waitUntil: "domcontentloaded" });
    await backend.locator(`iframe#${detail.moduleId}`).waitFor({ state: "visible", timeout: this.config.timeouts.blockRenderMs });
    const frame = backend.locator(`iframe#${detail.moduleId}`).contentFrame();
    const listLink = frame.getByRole("link", { name: detail.listPage, exact: true });
    await listLink.waitFor({ state: "visible" });
    // Module iframes load the navigation shell first; the data table is
    // fetched only after entering the corresponding list item.
    await listLink.click().catch(() => {});
    // The content backend uses two slightly different table templates: most
    // modules expose a title="前台查看" wrapper, while gallery/video rows may
    // render the public URL directly on the anchor. Keep both forms in scope
    // so a valid sample is not lost merely because the module template differs.
    const rows = frame.locator('tr').filter({
      has: frame.locator('[title="前台查看"] a, a[href^="http://"], a[href^="https://"]'),
    });
    await rows.first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
      throw new Error(`${detail.module}模块列表未加载可前台查看的记录`);
    });
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const rowText = await row.innerText();
      if (/草稿|下架|下线/.test(rowText)) continue;
      if (["文章", "图册"].includes(detail.module) && !rowText.includes("正常")) continue;
      const name = (await row.locator("td").nth(detail.titleCell).innerText()).trim();
      if (!name) continue;
      const view = row.locator('[title="前台查看"] a, a[href^="http://"], a[href^="https://"]').first();
      const href = await view.getAttribute("href");
      let publicPage;
      if (href && /^https?:\/\//i.test(href)) {
        const url = assertTargetDetailUrl(href, this.config.publicBaseUrl);
        publicPage = await this.context.newPage();
        await publicPage.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      } else {
        const popupPromise = this.context.waitForEvent("page", { timeout: 10_000 }).catch(() => null);
        await view.click({ force: true });
        publicPage = await popupPromise;
      }
      if (!publicPage) continue;
      try {
        await publicPage.waitForURL((url) => ["http:", "https:"].includes(url.protocol), {
          timeout: this.config.timeouts.blockRenderMs,
        });
        const url = assertTargetDetailUrl(publicPage.url(), this.config.publicBaseUrl);
        await publicPage.waitForLoadState("domcontentloaded").catch(() => {});
        // Some published templates render the detail body through client-side
        // scripts (and may expose only a minimal `top` shell until the site
        // assets finish loading).  The content block itself is verified later
        // by the detail runner, so discovery only needs a valid, target-host
        // URL opened from a row marked 正常.  Do not discard a usable record
        // merely because its first paint has not exposed the title yet.
        return { module: detail.module, name, url, pageTitle: await publicPage.title() };
      } finally {
        await publicPage.close().catch(() => {});
      }
    }
    throw new Error(`${detail.module}模块没有可前台访问的正常详情记录（候选行数=${count}）`);
  }

  async close() {
    if (this.backendPage && !this.backendPage.isClosed()) await this.backendPage.close();
  }
}
