import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAscendingProductNames,
  assertCategoryResult,
  assertExactCategoryResult,
  assertCompleteFlatResult,
  assertFlatModeEffect,
  assertDistinctPages,
  assertFieldVisibility,
  assertPageSize,
  assertRenderedColorChanged,
  normalizeProductCards,
} from "../src/ai-product-list-observations.mjs";

const products = [
  { id: "p1", name: "LY-A" },
  { id: "p2", name: "LY-B" },
  { id: "p3", name: "LY-C" },
  { id: "p4", name: "LY-D" },
  { id: "p5", name: "LY-E" },
];

test("产品卡片归一化保留 ID、名称和 URL", () => {
  assert.deepEqual(normalizeProductCards([{ id: " p1 ", name: " LY  A ", href: "/p1" }]), [{ id: "p1", name: "LY A", href: "/p1" }]);
});

test("分类结果必须是所选分类的非空真子集", () => {
  assert.deepEqual(assertCategoryResult(products.slice(0, 2), ["p1", "p2"], products.map((product) => product.id)).passed, true);
  assert.throws(() => assertCategoryResult(products.slice(0, 2), ["p1", "p3"], products.map((product) => product.id)), /非所选分类/);
  assert.throws(() => assertCategoryResult(products, products.map((product) => product.id), products.map((product) => product.id)), /与全部产品集合相同/);
});

test("指定单个产品分类时，渲染卡片 ID 必须与后台分类产品集合完全相等", () => {
  const baseline = products.map((product) => product.id);
  assert.deepEqual(assertExactCategoryResult([{ id: "p1", name: "LY-A" }], ["p1"], baseline), {
    passed: true,
    visible_ids: ["p1"],
    excluded_ids: ["p2", "p3", "p4", "p5"],
    expected_ids: ["p1"],
    exact_match: true,
    expected_count: 1,
    actual_count: 1,
  });
  assert.throws(() => assertExactCategoryResult([{ id: "p2", name: "LY-B" }], ["p1"], baseline), /非所选分类/);
  assert.throws(() => assertExactCategoryResult([], ["p1"], baseline), /没有展示产品/);
  assert.throws(() => assertExactCategoryResult([{ id: "p1", name: "LY-A" }], ["p1", "p2"], baseline), /缺少所选分类产品/);
});

test("排序、页数、翻页和整页加载按实际卡片数据断言", () => {
  assert.equal(assertAscendingProductNames(products), true);
  assert.throws(() => assertAscendingProductNames([...products].reverse()), /未升序/);
  assert.equal(assertPageSize(products, 5), true);
  assert.throws(() => assertPageSize(products.slice(0, 4), 5), /预期 5，实际 4/);
  assert.equal(assertDistinctPages(products, [{ id: "p6", name: "LY-F" }], 6), true);
  assert.throws(() => assertDistinctPages(products, [{ id: "p1", name: "LY-A" }]), /跨页重复/);
  assert.equal(assertCompleteFlatResult(products, products.map((product) => product.id)), true);
  assert.throws(() => assertCompleteFlatResult(products.slice(0, 4), products.map((product) => product.id)), /缺少/);
  assert.equal(assertFlatModeEffect(products, false, 4).visible_count, 5);
  assert.throws(() => assertFlatModeEffect(products, true, 4), /仍显示分页控件/);
  assert.throws(() => assertFlatModeEffect(products.slice(0, 4), false, 4), /未超过单页数量/);
});

test("字段与配色必须在渲染数据上发生变化", () => {
  assert.equal(assertFieldVisibility(false, false, "星级评价"), true);
  assert.throws(() => assertFieldVisibility(true, false, "星级评价"), /显示状态不匹配/);
  assert.equal(assertRenderedColorChanged("rgb(0, 143, 76)", "rgb(36, 88, 211)"), true);
  assert.throws(() => assertRenderedColorChanged("rgb(0, 143, 76)", "rgb(0, 143, 76)"), /没有发生可见变化/);
});
