import test from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouseWriter } from '../src/clickhouse-writer.js';

test('book failure never requeues a successfully committed trade batch', async () => {
  const calls = [];
  const client = {
    async insert({ table, values }) {
      calls.push({ table, values });
      if (table === 'orderbook_snapshots_v2') {
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
  assert.equal(calls.filter(x => x.table === 'raw_trades_v2').length, 1);
  assert.equal(calls.filter(x => x.table === 'orderbook_snapshots_v2').length, 1);
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

test('V2 table names are exposed in health for operational verification', () => {
  const writer = new ClickHouseWriter({ insert: async () => {} });
  const health = writer.health();
  assert.equal(health.trade_table, 'raw_trades_v2');
  assert.equal(health.book_table, 'orderbook_snapshots_v2');
});
