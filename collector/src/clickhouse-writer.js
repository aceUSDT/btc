function errorCode(err) {
  return err?.code || err?.cause?.code || err?.cause?.cause?.code || null;
}

function definitelyUnsent(err) {
  // These failures occur before an HTTP request can be accepted by ClickHouse.
  // Everything else is treated as ambiguous and is quarantined rather than
  // blindly reinserted, because the server may have committed the batch.
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(errorCode(err));
}

export class ClickHouseWriter {
  constructor(client, { maxTradeBuffer = 100000, maxBookBuffer = 20000, maxQuarantineBatches = 200 } = {}) {
    this.client = client;
    this.maxTradeBuffer = maxTradeBuffer;
    this.maxBookBuffer = maxBookBuffer;
    this.maxQuarantineBatches = maxQuarantineBatches;
    this.tradeBuffer = [];
    this.bookBuffer = [];
    this.tradeFlushInFlight = false;
    this.bookFlushInFlight = false;
    this.quarantine = [];
    this.lastTradeFlushAt = null;
    this.lastBookFlushAt = null;
    this.lastError = null;
  }

  enqueueTrade(row) {
    this.tradeBuffer.push(row);
    if (this.tradeBuffer.length > this.maxTradeBuffer) {
      this.tradeBuffer.splice(0, this.tradeBuffer.length - this.maxTradeBuffer);
    }
  }

  enqueueBook(row) {
    this.bookBuffer.push(row);
    if (this.bookBuffer.length > this.maxBookBuffer) {
      this.bookBuffer.splice(0, this.bookBuffer.length - this.maxBookBuffer);
    }
  }

  _quarantine(kind, batch, err) {
    this.quarantine.push({
      kind,
      at: new Date().toISOString(),
      error: String(err),
      rows: batch
    });
    if (this.quarantine.length > this.maxQuarantineBatches) this.quarantine.shift();
  }

  _handleFailure(kind, batch, err) {
    this.lastError = { kind, at: new Date().toISOString(), error: String(err), code: errorCode(err) };
    const target = kind === 'trades' ? this.tradeBuffer : this.bookBuffer;
    if (definitelyUnsent(err)) {
      target.unshift(...batch);
      return 'REQUEUED_DEFINITIVE_PRE_SEND_FAILURE';
    }
    this._quarantine(kind, batch, err);
    return 'QUARANTINED_AMBIGUOUS_FAILURE';
  }

  async flushTrades(limit = 20000) {
    if (this.tradeFlushInFlight || !this.tradeBuffer.length) return;
    this.tradeFlushInFlight = true;
    const batch = this.tradeBuffer.splice(0, Math.min(limit, this.tradeBuffer.length));
    try {
      await this.client.insert({ table: 'raw_trades', values: batch, format: 'JSONEachRow' });
      this.lastTradeFlushAt = new Date().toISOString();
    } catch (err) {
      this._handleFailure('trades', batch, err);
      throw err;
    } finally {
      this.tradeFlushInFlight = false;
    }
  }

  async flushBooks(limit = 5000) {
    if (this.bookFlushInFlight || !this.bookBuffer.length) return;
    this.bookFlushInFlight = true;
    const batch = this.bookBuffer.splice(0, Math.min(limit, this.bookBuffer.length));
    try {
      await this.client.insert({ table: 'orderbook_snapshots', values: batch, format: 'JSONEachRow' });
      this.lastBookFlushAt = new Date().toISOString();
    } catch (err) {
      this._handleFailure('books', batch, err);
      throw err;
    } finally {
      this.bookFlushInFlight = false;
    }
  }

  async flushAll() {
    const results = await Promise.allSettled([this.flushTrades(), this.flushBooks()]);
    return results;
  }

  health() {
    return {
      trade_buffer: this.tradeBuffer.length,
      book_buffer: this.bookBuffer.length,
      trade_flush_in_flight: this.tradeFlushInFlight,
      book_flush_in_flight: this.bookFlushInFlight,
      quarantined_batches: this.quarantine.length,
      last_trade_flush_at: this.lastTradeFlushAt,
      last_book_flush_at: this.lastBookFlushAt,
      last_error: this.lastError
    };
  }
}

export const __test = { definitelyUnsent, errorCode };
