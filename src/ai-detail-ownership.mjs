import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export function detailOwnershipPath(config, detail) {
  return path.join(config.paths.aiLifecycleDir, "detail-ownership", `${detail.moduleId}.json`);
}

export async function readDetailOwnership(config, detail) {
  try {
    return JSON.parse(await readFile(detailOwnershipPath(config, detail), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeDetailOwnership(config, detail, ownership) {
  const file = detailOwnershipPath(config, detail);
  const value = { ...ownership, updated_at: new Date().toISOString() };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
  return value;
}

export function identityKey(identity = {}) {
  if (identity.id) return `id:${identity.id}`;
  if (identity.pageId) return `page:${identity.pageId}`;
  if (identity.settingId && identity.text) return `fallback:${identity.settingId}:${identity.text}`;
  return "";
}

export function selectOwnedDetailCandidate(candidates, ownership) {
  const expected = identityKey(ownership?.identity);
  if (!expected) return [];
  const matches = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = identityKey(candidate.identity);
    if (key !== expected || seen.has(key)) continue;
    seen.add(key);
    matches.push(candidate);
  }
  return matches;
}

export function addedDetailCandidates(before, after) {
  const previous = new Set(before.map((item) => identityKey(item.identity)).filter(Boolean));
  return after.filter((item) => {
    const key = identityKey(item.identity);
    return key && !previous.has(key);
  });
}

export function createDetailOwnership(config, detail, runId, identity, status = "applied") {
  if (!identityKey(identity)) throw new Error(`${detail.type} 新区块缺少可安全复用的稳定标识`);
  return {
    version: 1,
    site_name: config.siteName,
    site_language: config.siteLanguage,
    system_page: detail.systemPage,
    type: detail.type,
    module_id: detail.moduleId,
    run_id: runId || "",
    identity,
    status,
    applied_at: new Date().toISOString(),
    published_verified: false,
  };
}

export function assertDetailOwnershipCompatible(ownership, config, detail) {
  if (!ownership) return null;
  if (ownership.site_name !== config.siteName || ownership.site_language !== config.siteLanguage ||
      ownership.system_page !== detail.systemPage || ownership.type !== detail.type) {
    throw new Error(`${detail.type} 所有权记录与当前站点或系统页不匹配`);
  }
  return ownership;
}
