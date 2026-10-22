export function sanitizeFrameUrl(value) {
  try {
    const url = new URL(String(value));
    const query = [...url.searchParams.keys()].map((key) => `${encodeURIComponent(key)}=[redacted]`).join("&");
    url.search = query ? `?${query}` : "";
    url.hash = "";
    return url.toString();
  } catch {
    return String(value ?? "").split("?")[0].split("#")[0];
  }
}

export function frameAncestry(frame) {
  const chain = [];
  const seen = new Set();
  let current = frame;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push({
      name: current.name?.() ?? "",
      url: sanitizeFrameUrl(current.url?.() ?? ""),
    });
    current = current.parentFrame?.() ?? null;
  }
  return chain.reverse();
}

export function isFrameWithin(frame, ancestor) {
  if (!frame || !ancestor) return false;
  let current = frame;
  const seen = new Set();
  while (current && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = current.parentFrame?.() ?? null;
  }
  return false;
}

export function isPagebuilderCanvasUrl(value) {
  try {
    const pathname = new URL(String(value)).pathname.replace(/\/$/, "");
    return pathname.startsWith("/phoenix/pagebuilder/")
      || (pathname === "/phoenix/pagebuilder");
  } catch {
    return /^\/phoenix\/pagebuilder(?:\/|\?|$)/.test(String(value ?? ""));
  }
}

export function choosePreviewContentFrame(frames, expectedPath) {
  const matches = frames.filter((frame) => {
    try {
      const url = new URL(frame.url?.() ?? "");
      return url.hostname.endsWith(".preview.leadong.com") && url.pathname === expectedPath;
    } catch {
      return false;
    }
  });
  if (matches.length > 1) throw new Error(`产品预览内容 frame 匹配到 ${matches.length} 个`);
  return matches[0] ?? null;
}

export function chooseProductCanvasCandidate(candidates, { fullScreen = false } = {}) {
  const visible = candidates.filter((candidate) => candidate.visible && candidate.hasProductCards);
  const pagebuilder = visible.filter((candidate) => isPagebuilderCanvasUrl(candidate.frame.url?.() ?? "")
    && !/\/phoenix\/pagebuilder\/layout(?:\?|$)/.test(candidate.frame.url?.() ?? ""));
  const eligible = fullScreen ? visible : pagebuilder;
  if (eligible.length !== 1) {
    throw new Error(`产品列表画布 frame 唯一匹配失败：${eligible.length} 个${eligible.length > 1 ? "（存在重复候选）" : "（未找到可见页面构建器画布）"}`);
  }
  return eligible[0];
}

export function chooseProductListPanelCandidate(candidates) {
  const eligible = candidates.filter((candidate) => candidate.visible
    && candidate.hasProductListTitle
    && candidate.hasRequiredSettings);
  if (eligible.length !== 1) {
    throw new Error(`产品列表设置侧栏唯一匹配失败：${eligible.length} 个${eligible.length > 1 ? "（存在重复可见侧栏）" : "（没有包含必需设置项的可见侧栏）"}`);
  }
  return eligible[0];
}
