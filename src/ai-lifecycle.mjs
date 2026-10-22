import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

function isoStamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export function createRunId() {
  return process.env.AI_RUN_ID?.trim() || `ai-regression-${isoStamp()}-${process.pid}`;
}

export function lifecyclePaths(config, runId) {
  const root = config.paths.aiLifecycleDir;
  return {
    root,
    active: path.join(root, "active.json"),
    manifest: path.join(root, `${runId}.json`),
    backupDir: path.join(root, "backups", runId),
  };
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function stateTargets(config, runId = "") {
  return [
    { key: "main", path: config.paths.aiStateFile },
    { key: "remaining", path: config.paths.aiRemainingStateDir },
    { key: "detail", path: config.paths.aiDetailStateDir },
    ...(runId ? [{ key: "run", path: path.join(config.paths.aiLifecycleDir, "runs", runId) }] : []),
  ];
}

async function copyTree(source, target) {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source)) await copyTree(path.join(source, entry), path.join(target, entry));
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

export async function loadActiveLifecycle(config) {
  const active = lifecyclePaths(config, "active").active;
  if (!(await exists(active))) return null;
  return readJson(active);
}

export async function prepareLifecycle(config, runId = createRunId()) {
  const paths = lifecyclePaths(config, runId);
  if (await exists(paths.active)) {
    const current = await readJson(paths.active);
    if (current.runId && current.runId !== runId) {
      throw new Error(`已有活动生命周期 ${current.runId}，请先执行 restore 或 cleanup`);
    }
  }
  const manifest = {
    version: 1,
    runId,
    status: "prepared",
    created_at: new Date().toISOString(),
    site_name: config.siteName,
    site_language: config.siteLanguage,
    public_base_url: config.publicBaseUrl,
    stateTargets: stateTargets(config, runId),
    backup: null,
    cleanup: null,
    restore: null,
  };
  await writeJson(paths.manifest, manifest);
  await writeJson(paths.active, { runId, manifest: paths.manifest, updated_at: new Date().toISOString() });
  return manifest;
}

export async function backupLifecycle(config, runId) {
  const paths = lifecyclePaths(config, runId);
  if (!(await exists(paths.manifest))) throw new Error(`找不到生命周期 ${runId}，请先执行 ai:prepare`);
  const manifest = await readJson(paths.manifest);
  const files = [];
  for (const target of stateTargets(config, runId)) {
    if (!(await exists(target.path))) {
      files.push({ ...target, existed: false });
      continue;
    }
    const destination = path.join(paths.backupDir, target.key);
    await copyTree(target.path, destination);
    files.push({ ...target, existed: true, backupPath: destination });
  }
  manifest.status = "backed_up";
  manifest.backup = { at: new Date().toISOString(), files };
  await writeJson(paths.manifest, manifest);
  return manifest;
}

export async function restoreLifecycle(config, runId) {
  const paths = lifecyclePaths(config, runId);
  if (!(await exists(paths.manifest))) throw new Error(`找不到生命周期 ${runId}`);
  const manifest = await readJson(paths.manifest);
  if (!manifest.backup) throw new Error(`生命周期 ${runId} 尚未创建测试前备份`);
  for (const file of manifest.backup.files) {
    if (file.existed) {
      await rm(file.path, { recursive: true, force: true });
      await copyTree(file.backupPath, file.path);
    } else {
      await rm(file.path, { recursive: true, force: true });
    }
  }
  manifest.status = "restored";
  manifest.restore = { at: new Date().toISOString() };
  await writeJson(paths.manifest, manifest);
  return manifest;
}

export async function cleanupLifecycle(config, runId) {
  const paths = lifecyclePaths(config, runId);
  if (!(await exists(paths.manifest))) throw new Error(`找不到生命周期 ${runId}`);
  const manifest = await readJson(paths.manifest);
  if (!manifest.backup) throw new Error(`生命周期 ${runId} 尚未创建测试前备份，拒绝清理`);
  // Cleanup is deliberately equivalent to restore for local state. Page-level
  // UI cleanup must use the run marker and is never guessed by deleting a
  // whole site page.
  const restored = await restoreLifecycle(config, runId);
  restored.status = "cleaned";
  restored.cleanup = { at: new Date().toISOString(), localState: "restored" };
  await writeJson(paths.manifest, restored);
  await rm(paths.active, { force: true });
  return restored;
}

export async function lifecycleStatus(config, runId) {
  const active = await loadActiveLifecycle(config);
  const selected = runId || active?.runId;
  if (!selected) return { active: null, manifest: null };
  const paths = lifecyclePaths(config, selected);
  return { active, manifest: await exists(paths.manifest) ? await readJson(paths.manifest) : null };
}
