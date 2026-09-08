import test from 'node:test';
import assert from 'node:assert/strict';
import { BybitBookReconstructor } from '../src/bybit-book.js';

test('delta before snapshot is not published', () => {
  const book = new BybitBookReconstructor();
  const result = book.applyMessage({ type: 'delta', data: { u: 2, seq: 2, b: [['100','1']], a: [] } });
  assert.equal(result.status, 'WAITING_SNAPSHOT');
  assert.equal(result.book, undefined);
});

test('reconstructs Bybit deltas against snapshot and preserves best levels', () => {
  const book = new BybitBookReconstructor();
  const snap = book.applyMessage({
    type: 'snapshot',
    data: { u: 100, seq: 1000, b: [['100','2'],['99','3']], a: [['101','2'],['102','4']] }
  });
  assert.equal(snap.book.bids[0][0], '100');
  assert.equal(snap.book.asks[0][0], '101');

  const delta = book.applyMessage({
    type: 'delta',
    data: { u: 101, seq: 1001, b: [['95','9']], a: [['104','7']] }
  });
  assert.equal(delta.status, 'APPLIED_DELTA');
  assert.equal(delta.book.bids[0][0], '100');
  assert.equal(delta.book.asks[0][0], '101');
});

test('zero size deletes a level and promotes the next level', () => {
  const book = new BybitBookReconstructor();
  book.applyMessage({ type: 'snapshot', data: { u: 10, seq: 20, b: [['100','2'],['99','3']], a: [['101','2'],['102','4']] } });
  const result = book.applyMessage({ type: 'delta', data: { u: 11, seq: 21, b: [['100','0']], a: [] } });
  assert.equal(result.book.bids[0][0], '99');
});

test('new snapshot replaces the local book', () => {
  const book = new BybitBookReconstructor();
  book.applyMessage({ type: 'snapshot', data: { u: 10, seq: 20, b: [['100','2']], a: [['101','2']] } });
  const result = book.applyMessage({ type: 'snapshot', data: { u: 50, seq: 80, b: [['200','1']], a: [['201','1']] } });
  assert.deepEqual(result.book.bids, [['200','1']]);
  assert.deepEqual(result.book.asks, [['201','1']]);
});

test('stale/replayed deltas are ignored', () => {
  const book = new BybitBookReconstructor();
  book.applyMessage({ type: 'snapshot', data: { u: 10, seq: 20, b: [['100','2']], a: [['101','2']] } });
  const result = book.applyMessage({ type: 'delta', data: { u: 9, seq: 19, b: [['150','5']], a: [] } });
  assert.equal(result.status, 'IGNORED');
  assert.equal(result.reason, 'non_monotonic_seq');
});
