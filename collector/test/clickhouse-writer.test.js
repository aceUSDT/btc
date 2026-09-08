import test from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouseWriter } from '../src/clickhouse-writer.js';

test('book failure never requeues a successfully committed trade batch', async () => {
  const calls = [];
  const client = {
    async insert({ table, values }) {
      calls.push({ table, values });
      if (table === 'orderbook_snapshots') {
        const err = new Error('connection refused');
        err.code = 'ECONNREFUSED';
        throw err;
      }
    }
  };
  const writer = new ClickHouseWriter(client);
  writer.enqueueTrade({ trade_id: 't1' });
  writer.enqueueBook({ sequence: 'b1' });
  await writer.flushAll();
  assert.equal(writer.tradeBuffer.length, 0);
  assert.equal(writer.bookBuffer.length, 1);
  assert.equal(calls.filter(x => x.table === 'raw_trades').length, 1);
});

test('ambiguous trade timeout is quarantined instead of blindly requeued', async () => {
  const client = {
    async insert() {
      const err = new Error('request timed out');
      err.code = 'ETIMEDOUT';
      throw err;
    }
  };
  const writer = new ClickHouseWriter(client);
  writer.enqueueTrade({ trade_id: 't1' });
  await assert.rejects(() => writer.flushTrades());
  assert.equal(writer.tradeBuffer.length, 0);
  assert.equal(writer.quarantine.length, 1);
  assert.equal(writer.quarantine[0].kind, 'trades');
});

test('definite pre-send trade failure can be requeued safely', async () => {
  const client = {
    async insert() {
      const err = new Error('dns');
      err.code = 'ENOTFOUND';
      throw err;
    }
  };
  const writer = new ClickHouseWriter(client);
  writer.enqueueTrade({ trade_id: 't1' });
  await assert.rejects(() => writer.flushTrades());
  assert.equal(writer.tradeBuffer.length, 1);
  assert.equal(writer.quarantine.length, 0);
});
