import test from "node:test";
import assert from "node:assert/strict";
import { browserLaunchOptions } from "../src/browser-options.mjs";

const config = { browser: { channel: "chrome", headless: false, slowMo: 180 } };

test("browser options preserve headed Chrome defaults outside CI", () => {
  assert.deepEqual(browserLaunchOptions(config, {}, {}), {
    channel: "chrome",
    headless: false,
    slowMo: 180,
  });
});

test("CI defaults to headless while explicit browser environment values take precedence", () => {
  assert.equal(browserLaunchOptions(config, {}, { CI: "true" }).headless, true);
  assert.equal("channel" in browserLaunchOptions(config, {}, { CI: "true" }), false);
  assert.equal(browserLaunchOptions(config, {}, { CI: "true", LEADONG_HEADLESS: "0" }).headless, false);
  assert.equal(browserLaunchOptions(config, {}, { LEADONG_HEADLESS: "1" }).headless, true);
  assert.equal(browserLaunchOptions(config, { headless: true }, {}).headless, true);
});

test("browser channel can select bundled Chromium or an installed browser channel", () => {
  assert.equal("channel" in browserLaunchOptions(config, {}, { LEADONG_BROWSER_CHANNEL: "" }), false);
  assert.equal("channel" in browserLaunchOptions(config, {}, { LEADONG_BROWSER_CHANNEL: "chromium" }), false);
  assert.equal(browserLaunchOptions(config, {}, { LEADONG_BROWSER_CHANNEL: "msedge" }).channel, "msedge");
});

test("slow motion environment override accepts zero and rejects invalid values", () => {
  assert.equal(browserLaunchOptions(config, {}, { LEADONG_SLOW_MO: "0" }).slowMo, 0);
  assert.equal(browserLaunchOptions(config, {}, { LEADONG_SLOW_MO: "35" }).slowMo, 35);
  assert.throws(() => browserLaunchOptions(config, {}, { LEADONG_SLOW_MO: "-1" }), /non-negative/);
  assert.throws(() => browserLaunchOptions(config, {}, { LEADONG_HEADLESS: "sometimes" }), /true, false, 1, or 0/);
});
