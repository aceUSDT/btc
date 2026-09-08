import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowAccumulator } from '../src/redis-state.js';

test('local flow accumulator remains bounded across time', () => {
  const flow = new FlowAccumulator({ retentionMinutes: 2 });
  const base = 1_800_000_000_000;
  for (let i = 0; i < 10; i++) {
    flow.recordTrade({
      event_time_ms: base + i * 60_000,
      venue: 'Binance',
      market_type: 'spot',
      notional_usd: 100,
      side: 'buy'
    });
  }
  flow.prune(base + 10 * 60_000);
  assert.ok(flow.size() <= 6, `expected bounded bucket count, got ${flow.size()}`);
});

test('flow windows are computed in-process and do not depend on Redis availability', () => {
  const flow = new FlowAccumulator({ retentionMinutes: 10 });
  const now = 1_800_000_000_000;
  flow.recordTrade({ event_time_ms: now, venue: 'Binance', market_type: 'spot', notional_usd: 200, side: 'buy' });
  flow.recordTrade({ event_time_ms: now, venue: 'Bybit', market_type: 'spot', notional_usd: 50, side: 'sell' });
  const w = flow.window('spot', 1, now);
  assert.equal(w.buy_usd, 200);
  assert.equal(w.sell_usd, 50);
  assert.equal(w.delta_usd, 150);
  assert.equal(w.trades, 2);
});
