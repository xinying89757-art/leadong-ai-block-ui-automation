export async function waitForCategoryTreeReady(readSnapshot, {
  timeoutMs = 20000,
  minWaitMs = 5000,
  stableMs = 1000,
  intervalMs = 200,
  now = Date.now,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const started = now();
  let stableSince = null;
  let previousSignature = "";
  let snapshot = null;
  while (now() - started < timeoutMs) {
    snapshot = await readSnapshot();
    const targets = snapshot?.targets ?? [];
    if (snapshot?.mode === "指定分类" && !snapshot.loading && targets.length === 1
      && targets[0].key && !targets[0].disabled && snapshot.nodeCount > 0) {
      const signature = JSON.stringify([snapshot.signature, targets[0].key]);
      if (signature !== previousSignature) stableSince = now();
      previousSignature = signature;
      if (now() - started >= minWaitMs && now() - stableSince >= stableMs) {
        return { ...snapshot, wait_ms: now() - started, minimum_wait_ms: minWaitMs, stable_ms: stableMs };
      }
    } else {
      stableSince = null;
      previousSignature = "";
    }
    await delay(intervalMs);
  }
  throw new Error(`指定分类列表未就绪：mode=${snapshot?.mode ?? ""}, loading=${snapshot?.loading ?? "unknown"}, targetCount=${snapshot?.targets?.length ?? 0}`);
}
