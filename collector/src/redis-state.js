import Redis from 'ioredis';

export function createBoundedRedis(url) {
  if (!url) throw new Error('REDIS_URL is required');
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    connectTimeout: 2000,
    lazyConnect: false,
    retryStrategy(attempt) {
      return Math.min(250 * attempt, 5000);
    }
  });
}

function minuteBucket(ms = Date.now()) {
  return Math.floor(ms / 60000) * 60000;
}

export class FlowAccumulator {
  constructor({ retentionMinutes = 120 } = {}) {
    this.retentionMinutes = retentionMinutes;
    this.buckets = new Map();
  }

  _record(key, trade) {
    const existing = this.buckets.get(key) || { buy_usd: 0, sell_usd: 0, delta_usd: 0, trades: 0 };
    const notional = Number(trade.notional_usd);
    if (trade.side === 'buy') existing.buy_usd += notional;
    else existing.sell_usd += notional;
    existing.delta_usd += trade.side === 'buy' ? notional : -notional;
    existing.trades += 1;
    this.buckets.set(key, existing);
  }

  recordTrade(trade) {
    const bucket = minuteBucket(trade.event_time_ms);
    this._record(`agg:${trade.market_type}:${bucket}`, trade);
    this._record(`venue:${trade.venue}:${trade.market_type}:${bucket}`, trade);
    this.prune();
  }

  prune(now = Date.now()) {
    const cutoff = minuteBucket(now) - this.retentionMinutes * 60000;
    for (const key of this.buckets.keys()) {
      const bucket = Number(key.split(':').at(-1));
      if (bucket < cutoff) this.buckets.delete(key);
    }
  }

  window(marketType, minutes, now = Date.now()) {
    const end = minuteBucket(now);
    const out = { buy_usd: 0, sell_usd: 0, delta_usd: 0, trades: 0 };
    for (let i = 0; i < minutes; i++) {
      const row = this.buckets.get(`agg:${marketType}:${end - i * 60000}`);
      if (!row) continue;
      out.buy_usd += row.buy_usd;
      out.sell_usd += row.sell_usd;
      out.delta_usd += row.delta_usd;
      out.trades += row.trades;
    }
    return out;
  }

  size() {
    return this.buckets.size;
  }
}

export class RedisPublisher {
  constructor(redis, { bookPublishIntervalMs = 200 } = {}) {
    this.redis = redis;
    this.bookPublishIntervalMs = bookPublishIntervalMs;
    this.lastBookPublish = new Map();
    this.lastStateAt = null;
    this.lastBookAt = null;
    this.lastError = null;
  }

  get available() {
    return this.redis.status === 'ready';
  }

  async publishState(state) {
    if (!this.available) return false;
    try {
      const json = JSON.stringify(state);
      const p = this.redis.pipeline();
      p.set('btc:state', json, 'EX', 10);
      p.publish('btc:state:updates', json);
      await p.exec();
      this.lastStateAt = new Date().toISOString();
      return true;
    } catch (err) {
      this.lastError = { at: new Date().toISOString(), error: String(err) };
      return false;
    }
  }

  async publishBook(book) {
    if (!this.available) return false;
    const key = `btc:book:${book.venue}:${book.market_type}`;
    const now = Date.now();
    const last = this.lastBookPublish.get(key) || 0;
    if (now - last < this.bookPublishIntervalMs) return false;
    this.lastBookPublish.set(key, now);
    try {
      await this.redis.set(key, JSON.stringify(book), 'EX', 30);
      this.lastBookAt = new Date().toISOString();
      return true;
    } catch (err) {
      this.lastError = { at: new Date().toISOString(), error: String(err) };
      return false;
    }
  }

  async publishDerivatives(venues) {
    if (!this.available) return false;
    try {
      const p = this.redis.pipeline();
      for (const [venue, value] of Object.entries(venues)) {
        p.set(`btc:derivatives:${venue}`, JSON.stringify(value), 'EX', 30);
      }
      p.set('btc:derivatives:all', JSON.stringify(venues), 'EX', 30);
      await p.exec();
      return true;
    } catch (err) {
      this.lastError = { at: new Date().toISOString(), error: String(err) };
      return false;
    }
  }

  health() {
    return {
      status: this.redis.status,
      available: this.available,
      last_state_at: this.lastStateAt,
      last_book_at: this.lastBookAt,
      last_error: this.lastError
    };
  }
}

export const __test = { minuteBucket };
