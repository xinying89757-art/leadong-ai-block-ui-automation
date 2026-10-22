import assert from "node:assert/strict";
import test from "node:test";
import { isLanguageOptionSelected } from "../src/editor.mjs";

test("进入已选中的站点语言时跳过冗余点击", () => {
  assert.equal(isLanguageOptionSelected({ className: "lanItem on ld-done" }), true);
  assert.equal(isLanguageOptionSelected({ className: "lanItem", ariaSelected: "true" }), true);
  assert.equal(isLanguageOptionSelected({ className: "lanItem", ariaSelected: "false" }), false);
});
