import test from "node:test";
import assert from "node:assert/strict";
import { LeadongEditor } from "../src/editor.mjs";
import { AiPagedAutomation } from "../src/ai-paged-runner.mjs";
import { AiCompositeRegressionAutomation } from "../src/ai-composite-runner.mjs";
import { DetailContentBrowser } from "../src/ai-detail-content.mjs";

function collection(items) {
  return { first: () => items[0], count: async () => items.length, nth: index => items[index] };
}

function instantClock(t) {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (resolve, ms) => { now += ms; queueMicrotask(resolve); });
}

test("页面菜单优先点击已知工具栏锚点，仍支持文字定位且跳过已展开菜单", async () => {
  for (const mode of ["stable", "fallback", "open"]) {
    const calls = [];
    const stable = { isVisible: async () => true, click: async () => calls.push("stable") };
    const fallbackTrigger = { ...stable, click: async () => calls.push("fallback") };
    const text = { ...stable, locator: () => ({ locator: () => collection([fallbackTrigger]) }) };
    const menu = { evaluate: async () => mode === "open", locator: selector => {
      assert.equal(selector, "a.backstage-topToolbar-menuIcon");
      return collection(mode === "stable" ? [stable] : []);
    } };
    const page = { locator: selector => { assert.equal(selector, "#backstage_select_pages"); return collection([menu]); },
      getByText: () => { assert.equal(mode, "fallback"); return collection([text]); } };
    const editor = new LeadongEditor(page, { selectors: { pageMenuTexts: ["页面"] } });
    editor.contexts = () => [page];
    editor.dismissBlockingDialogs = async () => {};
    await editor.openPageMenu();
    assert.deepEqual(calls, mode === "open" ? [] : [mode]);
  }
});

test("站点列表等待 attached 条件，预算来自配置，保留其余稳定等待", async () => {
  const calls = [];
  let url = "https://fixture.test/sites";
  const cards = { ...collection([{}]), waitFor: async options => calls.push(options) };
  cards.first = () => cards;
  const hidden = { first() { return this; }, isVisible: async () => false };
  const page = { goto: async () => {}, url: () => url,
    locator: selector => selector === ".site-card" ? cards : hidden,
    waitForTimeout: async ms => calls.push(ms) };
  const editor = new LeadongEditor(page, { editorUrl: url, siteListUrlIncludes: "/sites",
    selectors: { siteCardSelector: ".site-card" }, timeouts: { actionMs: 1234 },
    ai: { fullPageRegression: { editorStabilizeMs: 5678 } } });
  editor.enterTargetSite = async () => { url = "https://fixture.test/phoenix/pagebuilder"; };
  editor.waitForCanvasReady = async () => calls.push("canvas");
  await editor.goto();
  assert.deepEqual(calls, [1200, { state: "attached", timeout: 1234 }, "canvas", 5678]);
});

test("进入编辑器后等待已知画布就绪条件，移除导航后的固定一秒", async () => {
  let url = "https://fixture.test/sites";
  const calls = [];
  const hidden = { isVisible: async () => false };
  const edit = { isVisible: async () => true, click: async () => { url = "https://fixture.test/phoenix/pagebuilder"; } };
  const language = { filter() { return this; }, first: () => hidden };
  const card = { isVisible: async () => true, getByText: () => collection([edit]), locator: selector => {
    if (selector === ".language") return language;
    if (selector === ".edit") return collection([edit]);
    return { evaluateAll: async () => [] };
  } };
  const page = { locator: () => collection([card]), url: () => url, isClosed: () => false,
    on: () => {}, off: () => {}, mainFrame: () => null,
    setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
    waitForLoadState: async state => calls.push(state) };
  page.context = () => ({ pages: () => [page] });
  const editor = new LeadongEditor(page, { siteName: "Fixture", siteLanguage: "英语",
    selectors: { siteCardSelector: ".card", siteLanguageSelector: ".language", editSiteSelector: ".edit" },
    timeouts: { actionMs: 1234, blockRenderMs: 5678 } });
  editor.waitForCanvasReady = async () => calls.push("canvas-ready");
  await editor.enterTargetSite();
  assert.deepEqual(calls, ["domcontentloaded", "canvas-ready"]);
});

test("删除区块轮询原审计条件：及时完成、超时返回 false、审计错误仍传播", async (t) => {
  instantClock(t);
  for (const mode of ["ready", "timeout", "error"]) {
    let reads = 0;
    const failure = new Error("审计失败");
    const remove = { isVisible: async () => true, click: async () => {} };
    const root = { ...remove, hover: async () => {}, getByText: () => collection([remove]) };
    const editor = new LeadongEditor({ getByText: () => collection([]) }, {
      selectors: { deleteBlockTexts: ["删除"] }, timeouts: { actionMs: 250 },
    });
    editor.canvasContexts = () => [{ locator: () => collection([root]) }];
    editor.auditBlock = async () => {
      reads++;
      if (mode === "error") throw failure;
      return mode === "ready" && reads === 2 ? [] : [{ fingerprint: "#block" }];
    };
    if (mode === "error") await assert.rejects(editor.removeBlock("block", { fingerprint: "#block" }), e => e === failure);
    else assert.equal(await editor.removeBlock("block", { fingerprint: "#block" }), mode === "ready");
    assert.equal(reads, mode === "ready" ? 2 : mode === "timeout" ? 3 : 1);
  }
});

test("复合类型菜单等待已有可见条件，失败保留原错误，不进行固定睡眠", async () => {
  for (const opens of [true, false]) {
    let visible = false;
    const calls = [];
    const option = { first() { return this; }, isVisible: async () => visible,
      waitFor: async options => { calls.push(options); if (!opens) throw new Error("timeout"); visible = true; } };
    const frame = { locator: selector => {
      if (selector === "trigger") return { click: async () => calls.push("click") };
      if (selector === "button.block-category-option") return option;
      assert.fail(`unexpected selector ${selector}`);
    } };
    // Stop at the next, unchanged static-option check after the wait succeeds.
    option.filter = () => ({ count: async () => 0 });
    const config = { paths: {}, ai: { compositeRegression: { type: "复合区块", staticType: "静态图文" } },
      selectors: { aiCategoryTriggerSelector: "trigger" }, timeouts: { actionMs: 4321 } };
    const runner = new AiCompositeRegressionAutomation({ page: {} }, config, {});
    runner.state = { types: [{ type: "复合区块" }] };
    await assert.rejects(runner.selectType(frame, "复合区块"), opens ? /未唯一找到静态布局/ : /未打开 AI 区块类型菜单/);
    assert.deepEqual(calls, ["click", { state: "visible", timeout: 4321 }]);
  }
});

test("详情后台卡片等待可见条件，超时保留站点缺失错误并关闭临时页", async () => {
  let closed = false;
  const calls = [];
  const card = { first() { return this; }, waitFor: async options => { calls.push(options); throw new Error("timeout"); },
    isVisible: async () => false };
  const hidden = { first() { return this; }, isVisible: async () => false };
  const landing = { goto: async () => {}, url: () => "https://fixture.test/sites",
    locator: selector => selector === ".site-card" ? { filter: () => card } : hidden,
    close: async () => { closed = true; } };
  const browser = new DetailContentBrowser({ newPage: async () => landing }, {
    siteName: "Fixture", selectors: { siteCardSelector: ".site-card" }, timeouts: { blockRenderMs: 1234 },
    auth: { adminUrl: "https://fixture.test/sites" },
  });
  await assert.rejects(browser.open(), { message: "内容管理后台中未找到站点 Fixture" });
  assert.deepEqual(calls, [{ state: "visible", timeout: 1234 }]);
  assert.equal(closed, true);
});

test("历史插入优先已知配置选择器，缺失时按 role、文字回退", async () => {
  for (const chosen of ["stable", "role", "text"]) {
    const control = name => ({ first() { return this; }, isVisible: async () => name === chosen, name });
    const card = { innerText: async () => "静态图文 unique-prompt", getAttribute: async () => "record-id",
      locator: selector => { assert.equal(selector, ".known-insert"); return control("stable"); },
      getByRole: () => control("role"), getByText: () => control("text") };
    const cards = { count: async () => 1, nth: () => card,
      filter: () => ({ first: () => ({ isVisible: async () => true }) }) };
    const frame = { locator: selector => selector === ".cards" ? cards : control("hidden") };
    const config = { paths: {}, ai: {}, timeouts: { blockRenderMs: 1000 },
      selectors: { aiHistoryTriggerSelector: ".history", aiHistoryCardSelector: ".cards", aiHistoryInsertSelector: ".known-insert" } };
    const runner = new AiPagedAutomation({}, config, {});
    const result = await runner.historyRecord(frame, { type: "静态图文", generation_record_id: "record-id" });
    assert.equal(result.insert.name, chosen);
  }
});

test("历史恢复优先 button 应用模块，保留纯文字控件回退", async () => {
  for (const available of ["button", "text"]) {
    const selected = new Error(available);
    const control = kind => ({ first() { return this; },
      isVisible: async () => kind === "text" || available === "button",
      isEnabled: async () => true,
      click: async () => { assert.equal(kind, available); throw selected; } });
    const frame = { childFrames: () => [], getByText: () => control("text"),
      locator: selector => { assert.equal(selector, "button"); return { filter: () => control("button") }; } };
    const runner = new AiPagedAutomation({ page: { waitForTimeout: async () => {} } },
      { paths: {}, ai: {}, timeouts: { blockRenderMs: 1000 } }, {});
    runner.canvasSnapshot = async () => ({ count: 0 });
    runner.openAiDialog = async () => frame;
    runner.historyRecord = async () => ({ insert: { click: async () => {} } });
    await assert.rejects(runner.recoverStandardGeneratedResult({}), error => error === selected);
  }
});
