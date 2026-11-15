'use strict';

const TEST_DURATION_MS = 60 * 1000;
const TICK_INTERVAL_MS = 5000;

let ctx = null;
let timer = null;
let startTs = 0;
let successCount = 0;
let errorCount = 0;
let lastLatencyMs = null;
let lastError = null;

async function tick() {
  if (!timer || !ctx || ctx.isStopped()) return;

  const elapsed = Date.now() - startTs;
  if (elapsed >= TEST_DURATION_MS) {
    clearInterval(timer); timer = null;
    ctx.log('info', 'test_complete', { duration_ms: elapsed, successCount, errorCount });
    return;
  }

  const t0 = Date.now();
  try {
    // mouse_move_rel এর বদলে ping ব্যবহার করা হলো (READ action, no popup)
    await ctx.act('ping', {});
    lastLatencyMs = Date.now() - t0;
    successCount++;
    
    // প্রতি ১০ বার পর পর লগ দিবে, যাতে টার্মিনাল ফুল না হয়ে যায়
    if (successCount % 10 === 0) {
      ctx.log('info', 'tick_ok', { n: successCount, latency_ms: lastLatencyMs });
    }
  } catch (e) {
    lastError = String(e);
    errorCount++;
    ctx.log('error', 'tick_failed', { n: successCount + errorCount, error: lastError });
    if (errorCount >= 3) {
      clearInterval(timer); timer = null;
      ctx.log('error', 'test_aborted_after_errors', { errorCount, lastError });
    }
  }
}

module.exports = {
  name: 'task_00_phase1_test',
  async init(context) {
    ctx = context;
    startTs = Date.now();
    ctx.log('info', 'init', { duration_ms: TEST_DURATION_MS, tick_ms: TICK_INTERVAL_MS, cmd: 'ping' });
    timer = setInterval(tick, TICK_INTERVAL_MS);
    setTimeout(tick, 1000);
  },
  async shutdown() {
    if (timer) { clearInterval(timer); timer = null; }
    if (ctx) ctx.log('info', 'shutdown', { successCount, errorCount });
  },
};