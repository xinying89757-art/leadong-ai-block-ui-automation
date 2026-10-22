export function normalizeArticleCards(cards) {
  return (cards ?? []).map((card, index) => ({
    id: String(card?.id ?? card?.articleId ?? card?.dataId ?? "").trim(),
    title: String(card?.title ?? "").replace(/\s+/g, " ").trim(),
    date: String(card?.date ?? "").trim(),
    category: String(card?.category ?? "").replace(/\s+/g, " ").trim(),
    summary: String(card?.summary ?? "").replace(/\s+/g, " ").trim(),
    text: String(card?.text ?? "").replace(/\s+/g, " ").trim(),
    href: String(card?.href ?? "").trim(),
    categoryIds: (card?.categoryIds ?? []).map(String),
    fields: Object.fromEntries(Object.entries(card?.fields ?? {}).map(([key, value]) => [key, Boolean(value)])),
    colors: (card?.colors ?? []).map(String),
    index,
  }));
}

export function assertUniqueArticleIds(cards, label = "文章结果") {
  const ids = cards.map((card) => String(card.id ?? "")).filter(Boolean);
  if (ids.length !== cards.length) throw new Error(`${label}缺少文章 ID，无法进行结果级断言`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label}包含重复文章 ID`);
  return ids;
}

export function assertArticleCategoryResult(cards, expectedIds, baselineIds = []) {
  const ids = assertUniqueArticleIds(cards, "分类文章结果");
  const expected = new Set(expectedIds.map(String));
  if (!expected.size) throw new Error("后台分类文章 ID 数据为空");
  if (!ids.length) throw new Error("所选分类没有展示文章");
  const unexpected = ids.filter((id) => !expected.has(id));
  const missing = [...expected].filter((id) => !ids.includes(id));
  if (unexpected.length) throw new Error(`分类文章结果包含非目标文章 ID：${unexpected.join(", ")}`);
  if (missing.length) throw new Error(`分类文章结果缺少目标文章 ID：${missing.join(", ")}`);
  if (baselineIds.length && expected.size >= baselineIds.length) throw new Error("目标分类未排除其他文章，无法证明筛选效果");
  return { ids, expected_ids: [...expected], count: ids.length, exact_match: true };
}

export function assertArticleSort(cards, { field = "date", direction = "desc" } = {}) {
  if (cards.length < 2) throw new Error("文章数量不足，无法验证排序顺序");
  const values = cards.map((card) => field === "title" ? String(card.title).toLocaleLowerCase() : Date.parse(card.date));
  if (values.some((value) => value === "" || Number.isNaN(value))) throw new Error(`文章${field === "date" ? "发布日期" : "标题"}缺失，无法验证排序`);
  const ordered = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0) * (direction === "desc" ? -1 : 1));
  if (values.some((value, index) => value !== ordered[index])) throw new Error(`文章结果未按${field} ${direction}排序`);
  return { field, direction, values };
}

export function assertArticleCatalogSort(cards, catalogArticles, { direction = "desc" } = {}) {
  const publishedAtByTitle = new Map();
  for (const article of catalogArticles ?? []) {
    const title = String(article.title ?? "").trim();
    const publishedAt = Date.parse(String(article.published_at ?? "").replace(" ", "T"));
    if (!title || !Number.isFinite(publishedAt)) continue;
    if (publishedAtByTitle.has(title) && publishedAtByTitle.get(title) !== publishedAt) {
      throw new Error(`后台存在同名但发布时间不同的文章，无法安全按标题映射：${title}`);
    }
    publishedAtByTitle.set(title, publishedAt);
  }
  if (publishedAtByTitle.size < 2) throw new Error("后台可映射的文章发布时间不足，无法验证排序效果");
  const values = cards.map((card) => {
    const value = publishedAtByTitle.get(String(card.title ?? "").trim());
    if (!Number.isFinite(value)) throw new Error(`公开文章“${card.title}”无法映射到后台发布时间`);
    return value;
  });
  const ordered = [...values].sort((a, b) => direction === "asc" ? a - b : b - a);
  if (values.some((value, index) => value !== ordered[index])) throw new Error(`文章列表未按后台发布时间${direction === "desc" ? "降序" : "升序"}排列`);
  return { field: "backend_published_at", direction, values, ordered_titles: cards.map((card) => card.title), distinct_timestamps: new Set(values).size, source: "content-management-article-catalog" };
}

export function assertArticlePageSize(cards, expected = 5) {
  if (!Number.isInteger(expected) || expected < 1) throw new Error("文章分页预期数量必须为正整数");
  if (cards.length !== expected) throw new Error(`文章列表每页应展示 ${expected} 篇，实际 ${cards.length} 篇`);
  const ids = assertUniqueArticleIds(cards, "文章分页");
  return { expected_count: expected, actual_count: cards.length, ids };
}

export function assertArticlePagination({ firstPage, secondPage, pagerVisible, totalArticles }) {
  if (totalArticles <= firstPage.length) throw new Error(`后台文章仅 ${totalArticles} 篇，数据不足以验证翻页`);
  if (!pagerVisible) throw new Error("文章分页模式未显示页码控件");
  if (!firstPage.length || !secondPage.length) throw new Error("翻页后文章列表为空");
  const firstIds = assertUniqueArticleIds(firstPage, "文章第一页");
  const secondIds = assertUniqueArticleIds(secondPage, "文章第二页");
  if (firstIds.some((id) => secondIds.includes(id))) throw new Error("文章翻页后重复显示同一文章");
  if (secondPage.length > firstPage.length) throw new Error("文章第二页数量超过第一页分页数量");
  return { pager_visible: true, first_page_ids: firstIds, second_page_ids: secondIds, total_articles: totalArticles };
}

export function assertArticleFieldVisibility(before, after, field) {
  if (before !== true || after !== false) throw new Error(`文章展示字段 ${field} 未从可见变为隐藏`);
  return { field, before_visible: before, after_visible: after, changed: true };
}

export function assertArticleRenderedColorChanged(beforeColors, afterColors) {
  if (!beforeColors?.length || !afterColors?.length) throw new Error("文章 CTA 缺少计算样式颜色证据");
  if (beforeColors.every((color) => afterColors.includes(color))) throw new Error("文章基础配色修改后 CTA 实际渲染颜色未变化");
  return { before: beforeColors, after: afterColors, changed: true };
}
