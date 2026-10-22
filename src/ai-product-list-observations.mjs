export function normalizeProductCards(cards) {
  return (cards ?? []).map((card) => ({
    id: String(card?.id ?? "").trim(),
    name: String(card?.name ?? "").replace(/\s+/g, " ").trim(),
    href: String(card?.href ?? "").trim(),
  })).filter((card) => card.id || card.name);
}

export function assertUniqueProductIds(cards, label = "产品列表") {
  const ids = cards.map((card) => card.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error(`${label}存在重复产品 ID`);
  if (ids.length !== cards.length) throw new Error(`${label}存在缺少产品 ID 的卡片`);
  return true;
}

export function assertCategoryResult(cards, expectedIds, baselineIds) {
  assertUniqueProductIds(cards, "分类筛选结果");
  const expected = new Set(expectedIds);
  const baseline = new Set(baselineIds);
  if (!expected.size) throw new Error("分类校验数据为空");
  if (!cards.length) throw new Error("所选分类没有展示产品");
  const unexpected = cards.map((card) => card.id).filter((id) => !expected.has(id));
  if (unexpected.length) throw new Error(`分类结果包含非所选分类产品：${unexpected.join(", ")}`);
  const excluded = [...baseline].filter((id) => !expected.has(id));
  if (!excluded.length) throw new Error("所选分类与全部产品集合相同，无法证明筛选生效");
  if (cards.some((card) => excluded.includes(card.id))) throw new Error("分类筛选结果仍包含基线中不属于所选分类的产品");
  return { passed: true, visible_ids: cards.map((card) => card.id), excluded_ids: excluded };
}

export function assertExactCategoryResult(cards, expectedIds, baselineIds) {
  const evidence = assertCategoryResult(cards, expectedIds, baselineIds);
  const expected = [...new Set(expectedIds.map(String))].sort();
  const actual = cards.map((card) => String(card.id)).sort();
  const missing = expected.filter((id) => !actual.includes(id));
  if (missing.length) throw new Error(`分类结果缺少所选分类产品：${missing.join(", ")}`);
  if (actual.length !== expected.length) {
    throw new Error(`分类结果产品数量与所选分类不一致：预期 ${expected.length}，实际 ${actual.length}`);
  }
  return { ...evidence, expected_ids: expected, exact_match: true, expected_count: expected.length, actual_count: actual.length };
}

export function assertAscendingProductNames(cards, locale = "en") {
  if (cards.length < 2) throw new Error("产品数量不足，无法验证名称排序");
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  for (let index = 1; index < cards.length; index += 1) {
    if (collator.compare(cards[index - 1].name, cards[index].name) > 0) {
      throw new Error(`产品名称未升序：${cards[index - 1].name} → ${cards[index].name}`);
    }
  }
  return true;
}

export function assertPageSize(cards, expected = 5) {
  if (!Number.isInteger(expected) || expected < 1) throw new Error("预期每页数量无效");
  if (cards.length !== expected) throw new Error(`每页产品数量不匹配：预期 ${expected}，实际 ${cards.length}`);
  assertUniqueProductIds(cards, "分页结果");
  return true;
}

export function assertDistinctPages(firstPage, nextPage, expectedTotal = 0) {
  assertUniqueProductIds(firstPage, "第一页");
  assertUniqueProductIds(nextPage, "下一页");
  const firstIds = new Set(firstPage.map((card) => card.id));
  if (!nextPage.length || nextPage.some((card) => firstIds.has(card.id))) throw new Error("翻页后产品没有变化或出现跨页重复");
  if (expectedTotal > 0 && firstPage.length + nextPage.length !== expectedTotal) {
    throw new Error(`分页产品总数不匹配：预期 ${expectedTotal}，实际 ${firstPage.length + nextPage.length}`);
  }
  return true;
}

export function assertCompleteFlatResult(cards, expectedIds) {
  assertUniqueProductIds(cards, "平铺结果");
  const expected = new Set(expectedIds);
  const actual = new Set(cards.map((card) => card.id));
  const missing = [...expected].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  if (missing.length || unexpected.length) throw new Error(`平铺结果与产品全集不一致；缺少 ${missing.join(",") || "无"}；多出 ${unexpected.join(",") || "无"}`);
  return true;
}

export function assertFlatModeEffect(cards, pagerVisible, pageSize = 5) {
  if (pagerVisible) throw new Error("平铺模式仍显示分页控件");
  if (cards.length <= pageSize) throw new Error(`平铺模式未超过单页数量：预期多于 ${pageSize}，实际 ${cards.length}`);
  const ids = cards.map((card) => card.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error("平铺模式存在重复产品 ID");
  return { visible_count: cards.length, identified_count: ids.length, page_size: pageSize };
}

export function assertFieldVisibility(actual, expected, label) {
  if (Boolean(actual) !== Boolean(expected)) throw new Error(`${label}显示状态不匹配：预期 ${expected ? "显示" : "隐藏"}，实际 ${actual ? "显示" : "隐藏"}`);
  return true;
}

export function assertRenderedColorChanged(before, after, label = "产品卡片配色") {
  if (!before || !after || before === after) throw new Error(`${label}没有发生可见变化`);
  return true;
}
