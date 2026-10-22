import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildRegressionHtml,
  formatDuration,
  normalizeRegressionReport,
  regressionReportPaths,
  writeRegressionReport,
} from "../src/ai-regression-report.mjs";

test("回归报告格式化累计执行耗时", () => {
  assert.equal(formatDuration(3_723_000), "1小时 2分 3秒");
  assert.equal(formatDuration(0), "0秒");
});

test("整页报告优先读取阶段结果指向的重试状态", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-regression-report-"));
  const child = path.join(root, "retry", "state.json");
  await mkdir(path.dirname(child), { recursive: true });
  await writeFile(child, JSON.stringify({
    page: { saved: true, editor_verified: true, preview_verified: true, published_verified: true, name: "retry-page", publicUrl: "https://example.test/retry" },
    generation: { generation_status: "succeeded", application_status: "applied" },
  }));
  const report = await normalizeRegressionReport({}, {
    run_id: "run-1", status: "passed", site_name: "site", site_language: "英语",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:01:00.000Z",
    stages: [{ key: "full-page", label: "AI 生成整页", status: "passed", attempts: 2, duration_ms: 60000, result: { stateFile: child } }],
  }, root);
  assert.equal(report.stages[0].checks[0].status, "passed");
  assert.equal(report.stages[0].source_file, child);
});

test("报告 HTML 使用状态颜色并脱敏敏感字段", () => {
  const html = buildRegressionHtml({
    runId: "run-x", status: "failed", siteName: "demo", siteLanguage: "英语",
    createdAt: "2026-01-01", updatedAt: "2026-01-01", duration: "2秒",
    passed: 1, failed: 1, blocked: 0, pending: 0,
    stages: [{ key: "x", label: "阶段", status: "failed", attempts: 1, duration_ms: 2000, started_at: "", completed_at: "", failure_reason: "password=secret", source_file: "", checks: [{ label: "检查 <x>", status: "failed", details: { error: "Authorization=jwt-secret" } }] }],
  });
  assert.match(html, /status-failed/);
  assert.match(html, /检查 &lt;x&gt;/);
  assert.doesNotMatch(html, /jwt-secret|password=secret/);
  assert.match(html, /敏感内容，已隐藏/);
});

test("报告写入每轮文件和 latest 文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-regression-report-"));
  const config = { paths: { aiRegressionReportsDir: path.join(root, "reports") } };
  const suiteRoot = path.join(root, "suite");
  const suiteState = {
    run_id: "run-2", status: "passed", site_name: "site", site_language: "英语",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:01:00.000Z",
    stages: [],
  };
  const paths = { root: suiteRoot };
  const output = await writeRegressionReport(config, suiteState, paths);
  assert.equal(await readFile(output.file, "utf8").then((text) => text.includes("AI 全量回归测试报告")), true);
  assert.equal(await readFile(output.latest, "utf8").then((text) => text.includes("run-2")), true);
  assert.equal(regressionReportPaths(config, "run-2").file, output.file);
});
