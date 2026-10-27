// Shared timing primitives. Polling bounds the loop, not an individual check;
// use withTimeout when the operation itself also needs a deadline.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PollTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "PollTimeoutError";
  }
}

export async function pollUntil(fn, {
  timeoutMs = 15000, intervalMs = 250, message = "条件等待超时", retryOnError = false,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      if (!retryOnError) throw error;
      lastError = error;
    }
    // Preserve the existing loops' full interval and check-before-sleep order.
    await sleep(intervalMs);
  }
  throw new PollTimeoutError(`${message}${lastError ? `：${lastError.message}` : ""}`);
}

export async function retry(fn, {
  attempts = 3, delayMs = 250, backoff = 1, shouldRetry = () => true,
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts 必须为正整数");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError("delayMs 必须为非负有限数");
  if (!Number.isFinite(backoff) || backoff < 1) throw new RangeError("backoff 必须为不小于 1 的有限数");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt === attempts || !await shouldRetry(error, attempt)) throw error;
      await sleep(delayMs * backoff ** (attempt - 1));
    }
  }
}

export async function fillAndVerify(locator, text) {
  const expected = String(text).trim();
  let actual = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await locator.fill(text);
    actual = await locator.inputValue();
    if (String(actual).trim() === expected) return actual;
  }
  throw new Error(`提示词填入校验失败：重试 2 次后仍与预期不一致（预期 ${expected.length} 字符，实际 ${String(actual).trim().length} 字符）`);
}

// Does not cancel the underlying operation. Both settlement paths clear the
// guard timer so successful calls do not keep Node alive until the deadline.
export async function withTimeout(promise, ms, message = "操作等待超时") {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
