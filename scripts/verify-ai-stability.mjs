// Offline headed timing fixture. No login, AI requests, points or site writes.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { loadConfig } from "../src/config.mjs";
import { AiFullPageAutomation } from "../src/ai-full-page-runner.mjs";
import { pageContentSnapshot } from "../src/ai-content-ready.mjs";

const config = await loadConfig("config/run.json");
config.ai.fullPageRegression = { ...config.ai.fullPageRegression, applicationTimeoutMs: 5000, applicationStableMs: 200, applicationPollIntervalMs: 25 };
const browser = await chromium.launch({ channel: "chrome", headless: false });
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(`Fixture page error: ${error.message}`));
  await page.setContent(`<h1>Offline AI insertion timing verification</h1><iframe id="canvas" style="width:95vw;height:70vh"></iframe><iframe id="ai-result" style="display:none"></iframe>`);
  const frame = await page.locator("#canvas").contentFrame();
  await frame.locator("body").evaluate((body) => {
    body.innerHTML = `<main id="backstage-bodyArea"><div class="siteblocks-setting-wrap" id="old-1">Old Home hero</div><div class="siteblocks-setting-wrap" id="old-2">Old Home products</div><div class="siteblocks-setting-wrap" id="old-3">Old Home contact</div></main>`;
    const area = body.querySelector("main");
    setTimeout(() => area.innerHTML = `<div class="siteblocks-setting-wrap" id="block-1"><h2>New Hero loaded</h2></div>`, 400);
    setTimeout(() => area.insertAdjacentHTML("beforeend", `<div class="siteblocks-setting-wrap" id="block-2">New Products loaded</div>`), 800);
    setTimeout(() => area.insertAdjacentHTML("beforeend", `<div class="siteblocks-setting-wrap" id="block-3">添加在这里</div>`), 1200);
    setTimeout(() => body.querySelector("#block-3").textContent = "New Contact loaded", 1600);
  });
  const targetName = "Offline history reuse target";
  const operations = [];
  const editor = {
    page, canvasContexts: () => page.frames().filter((candidate) => candidate !== page.mainFrame()),
    openCustomPage: async () => assert.fail("Must not refresh/reselect during addition"),
    waitForPageLoaded: async () => assert.fail("Old readiness shortcut must not be used"),
    customPageExists: async () => { operations.push("list"); return true; },
    savePage: async () => {
      const snapshot = await pageContentSnapshot(editor.canvasContexts(), { editor: true });
      assert.equal(snapshot.count, 3); assert.equal(snapshot.readyCount, 3); assert.equal(snapshot.loading, false);
      operations.push("save");
    },
  };
  const runner = new AiFullPageAutomation(editor, config, "offline-fixture");
  runner.state = { page: { name: targetName, creation_receipt: { business_status: 'succeeded', id: 'fixture-page' }, target_identity: { name: targetName, id: 'fixture-page' } }, generation: { expected_block_count: 3, application_status: "applying" } };
  const baseline = await pageContentSnapshot(editor.canvasContexts(), { editor: true });
  runner.state.generation.application_baseline = { block_ids: baseline.blockIds, fingerprint: baseline.fingerprint };
  runner.currentPageName = async () => targetName;
  runner.currentPageIdentity = async () => ({ name: targetName, id: 'fixture-page' });
  runner.persist = async () => {};
  const started = Date.now();
  try { await runner.finishPageCreation(); }
  catch (error) {
    console.error(await frame.locator("body").innerHTML());
    throw error;
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1600, `Barrier finished before final content: ${elapsed}ms`);
  assert.deepEqual(operations, []);
  await runner.verifyEditor();
  await editor.savePage();
  assert.deepEqual(operations, ["save"]);
  assert.equal(runner.state.page.editor_verified, true);

  const shellOnly = await browser.newPage();
  await shellOnly.setContent("<nav>Desktop Tablet Mobile Preview</nav>");
  assert.equal((await pageContentSnapshot(shellOnly.frames())).count, 0);
  const artifact = path.resolve("output/playwright/ai-stability-fixture.png");
  await mkdir(path.dirname(artifact), { recursive: true });
  await page.screenshot({ path: artifact });
  console.log(JSON.stringify({ ok: true, headed: true, offline: true, insertionBarrierMs: elapsed, blockCount: 3, oldHomeBlocksRejected: true, prematureNavigationOrSave: false, previewShellRejected: true, screenshot: artifact }, null, 2));
} finally { await browser.close(); }
