import assert from "node:assert/strict";
import test from "node:test";
import { isAiBlockDeleteConfirmLabel, isLanguageOptionSelected } from "../src/editor.mjs";

test("进入已选中的站点语言时跳过冗余点击", () => {
  assert.equal(isLanguageOptionSelected({ className: "lanItem on ld-done" }), true);
  assert.equal(isLanguageOptionSelected({ className: "lanItem", ariaSelected: "true" }), true);
  assert.equal(isLanguageOptionSelected({ className: "lanItem", ariaSelected: "false" }), false);
});

test("AI block delete confirmation recognizes Chinese and English editor labels", () => {
  for (const label of ["确定", "删除", "确认", "Delete", "Confirm", "OK", "Yes", "Remove"]) {
    assert.equal(isAiBlockDeleteConfirmLabel(label), true, label);
  }
  assert.equal(isAiBlockDeleteConfirmLabel("Cancel"), false);
});
