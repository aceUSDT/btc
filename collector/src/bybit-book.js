export class BybitBookReconstructor {
  constructor({ depth = 50 } = {}) {
    this.depth = depth;
    this.reset();
  }

  reset() {
    this.bids = new Map();
    this.asks = new Map();
    this.initialized = false;
    this.lastUpdateId = null;
    this.lastSeq = null;
  }

  _replace(sideMap, levels = []) {
    sideMap.clear();
    for (const [priceRaw, sizeRaw] of levels) {
      const price = Number(priceRaw);
      const size = Number(sizeRaw);
      if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
      sideMap.set(price, size);
    }
  }

  _apply(sideMap, levels = []) {
    for (const [priceRaw, sizeRaw] of levels) {
      const price = Number(priceRaw);
      const size = Number(sizeRaw);
      if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
      if (size === 0) sideMap.delete(price);
      else sideMap.set(price, size);
    }
  }

  _snapshot() {
    const bids = [...this.bids.entries()]
      .sort((a, b) => b[0] - a[0])
      .slice(0, this.depth)
      .map(([p, s]) => [String(p), String(s)]);
    const asks = [...this.asks.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, this.depth)
      .map(([p, s]) => [String(p), String(s)]);
    return { bids, asks, updateId: this.lastUpdateId, seq: this.lastSeq };
  }

  applyMessage(message) {
    const data = message?.data;
    if (!data) return { status: 'IGNORED', reason: 'missing_data' };

    const updateId = Number(data.u);
    const seq = Number(data.seq);
    const isSnapshot = message.type === 'snapshot' || updateId === 1;

    if (isSnapshot) {
      this._replace(this.bids, data.b || []);
      this._replace(this.asks, data.a || []);
      this.initialized = true;
      this.lastUpdateId = Number.isFinite(updateId) ? updateId : null;
      this.lastSeq = Number.isFinite(seq) ? seq : null;
      return { status: 'APPLIED_SNAPSHOT', book: this._snapshot() };
    }

    if (message.type !== 'delta') {
      return { status: 'IGNORED', reason: `unsupported_type:${message.type}` };
    }

    if (!this.initialized) {
      return { status: 'WAITING_SNAPSHOT', reason: 'delta_before_snapshot' };
    }

    // Bybit documents seq as an ordering field, not a guaranteed contiguous counter.
    // Therefore reject stale/replayed messages, but do not require seq+1 continuity.
    if (Number.isFinite(seq) && this.lastSeq !== null && seq <= this.lastSeq) {
      return { status: 'IGNORED', reason: 'non_monotonic_seq' };
    }
    if (Number.isFinite(updateId) && this.lastUpdateId !== null && updateId <= this.lastUpdateId) {
      return { status: 'IGNORED', reason: 'non_monotonic_update_id' };
    }

    this._apply(this.bids, data.b || []);
    this._apply(this.asks, data.a || []);
    if (Number.isFinite(updateId)) this.lastUpdateId = updateId;
    if (Number.isFinite(seq)) this.lastSeq = seq;

    return { status: 'APPLIED_DELTA', book: this._snapshot() };
  }
}
