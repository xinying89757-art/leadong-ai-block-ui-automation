import test from "node:test";
import assert from "node:assert/strict";
import { sleep, pollUntil, PollTimeoutError, retry, withTimeout } from "../src/wait-utils.mjs";
import { waitFor } from "../src/ai-full-page-runner.mjs";

function clock(t) {
  let now = 0;
  const delays = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (resolve, ms) => {
    delays.push(ms);
    now += ms;
    queueMicrotask(resolve);
  });
  return delays;
}

test("sleep 使用传入间隔，定时器完成前不返回", async (t) => {
  let finish, done = false;
  t.mock.method(globalThis, "setTimeout", (resolve, ms) => { assert.equal(ms, 42); finish = resolve; });
  const pending = sleep(42).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  finish();
  await pending;
  assert.equal(done, true);
});

test("pollUntil 首次立即检查，返回原始结果，只在未满足时等待", async (t) => {
  const delays = clock(t);
  let calls = 0;
  const result = { ready: true };
  assert.equal(await pollUntil(() => ++calls === 3 && result, { timeoutMs: 50, intervalMs: 10 }), result);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 10]);
  assert.equal(await pollUntil(() => result), result);
  assert.deepEqual(delays, [10, 10]);
});

test("pollUntil 默认传播检查错误；显式启用时才容忍瞬态错误", async (t) => {
  const delays = clock(t);
  const error = new Error("检查失败");
  await assert.rejects(pollUntil(() => { throw error; }), e => e === error);
  assert.deepEqual(delays, []);
  let calls = 0;
  assert.equal(await pollUntil(() => {
    if (++calls === 1) throw error;
    return "ready";
  }, { timeoutMs: 20, intervalMs: 5, retryOnError: true }), "ready");
  assert.deepEqual(delays, [5]);
});

test("pollUntil 到期停止检查，保留轮询节奏和最后一次瞬态错误信息", async (t) => {
  const delays = clock(t);
  let calls = 0;
  await assert.rejects(pollUntil(() => { calls++; throw new Error("iframe 暂不可用"); }, {
    timeoutMs: 25, intervalMs: 10, retryOnError: true, message: "内容等待超时",
  }), e => e instanceof PollTimeoutError && e.message === "内容等待超时：iframe 暂不可用");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 10, 10]);
  await assert.rejects(pollUntil(() => assert.fail("零预算不得检查"), { timeoutMs: 0, message: "已到期" }),
    { message: "已到期" });
});

test("整页 waitFor 适配器保留参数顺序、默认间隔、标签及立即传播错误", async (t) => {
  const delays = clock(t);
  let calls = 0;
  assert.equal(await waitFor(() => ++calls === 2 && "ready", 1000, "整页"), "ready");
  assert.deepEqual(delays, [300]);
  await assert.rejects(waitFor(() => false, 5, "整页", 5), { message: "整页等待超时" });
  const failure = new Error("业务失败");
  await assert.rejects(waitFor(() => { throw failure; }, 1000, "整页"), e => e === failure);
  assert.deepEqual(delays, [300, 5]);
});

test("retry 首次成功不延迟；失败后按次数和指数退避重试", async (t) => {
  const delays = clock(t);
  assert.equal(await retry(attempt => attempt), 1);
  assert.deepEqual(delays, []);
  const failures = [], attempts = [];
  assert.equal(await retry(attempt => {
    attempts.push(attempt);
    if (attempt < 3) throw new Error(`失败 ${attempt}`);
    return "done";
  }, { attempts: 4, delayMs: 10, backoff: 2, shouldRetry: async (error, attempt) => {
    failures.push([error.message, attempt]); return true;
  } }), "done");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(failures, [["失败 1", 1], ["失败 2", 2]]);
  assert.deepEqual(delays, [10, 20]);
});

test("retry 到达上限或 shouldRetry 拒绝时保留原错误，最后一次失败不再睡眠", async (t) => {
  const delays = clock(t);
  const failure = new Error("应用状态不确定");
  let calls = 0, decisions = 0;
  const fail = () => { calls++; throw failure; };
  await assert.rejects(retry(fail, { attempts: 3, delayMs: 7, shouldRetry: () => { decisions++; return true; } }), e => e === failure);
  assert.equal(calls, 3);
  assert.equal(decisions, 2);
  assert.deepEqual(delays, [7, 7]);
  await assert.rejects(retry(fail, { attempts: 3, shouldRetry: () => false }), e => e === failure);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [7, 7]);
  for (const options of [{ attempts: 0 }, { attempts: 1.5 }, { delayMs: -1 }, { backoff: 0 }, { backoff: Infinity }]) {
    await assert.rejects(retry(fail, options), RangeError);
  }
  assert.equal(calls, 4);
});

test("withTimeout 成功、失败和到期均清理保护定时器，保留结果或原始拒绝", async (t) => {
  const guards = [], cleared = [];
  t.mock.method(globalThis, "setTimeout", (callback, ms) => {
    const timer = { callback, ms }; guards.push(timer); return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => cleared.push(timer));
  const result = {};
  assert.equal(await withTimeout(Promise.resolve(result), 100), result);
  const failure = new Error("原始失败");
  await assert.rejects(withTimeout(Promise.reject(failure), 200), e => e === failure);
  const pending = withTimeout(new Promise(() => {}), 300, "视觉定位超时");
  const rejected = assert.rejects(pending, { message: "视觉定位超时" });
  guards[2].callback();
  await rejected;
  assert.deepEqual(guards.map(item => item.ms), [100, 200, 300]);
  assert.deepEqual(cleared, guards);
});
