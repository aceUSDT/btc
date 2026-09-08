import WebSocket from 'ws';
import { createClient as createClickHouseClient } from '@clickhouse/client';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import Fastify from 'fastify';
import pino from 'pino';
import { BybitBookReconstructor } from './bybit-book.js';
import { ClickHouseWriter } from './clickhouse-writer.js';
import { createBoundedRedis, FlowAccumulator, RedisPublisher } from './redis-state.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const fastify = Fastify({ logger: false });
const redis = createBoundedRedis(process.env.REDIS_URL);
const redisPublisher = new RedisPublisher(redis, {
  bookPublishIntervalMs: Number(process.env.REDIS_BOOK_PUBLISH_MS || 200)
});
const clickhouse = createClickHouseClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_PASSWORD || '',
  database: process.env.CLICKHOUSE_DB || 'btc',
  request_timeout: Number(process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS || 10000)
});
const clickhouseWriter = new ClickHouseWriter(clickhouse, {
  maxTradeBuffer: Number(process.env.MAX_TRADE_BUFFER || 100000),
  maxBookBuffer: Number(process.env.MAX_BOOK_BUFFER || 20000),
  maxQuarantineBatches: Number(process.env.MAX_QUARANTINE_BATCHES || 200)
});
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

const flow = new FlowAccumulator({ retentionMinutes: Number(process.env.FLOW_RETENTION_MINUTES || 120) });
const localBooks = new Map();
const lastBookSample = new Map();
const derivativeState = {};
const BOOK_SAMPLE_MS = Number(process.env.BOOK_SAMPLE_MS || 1000);
const STATE_INTERVAL_MS = Number(process.env.STATE_INTERVAL_MS || 1000);
const REST_POLL_MS = Number(process.env.REST_POLL_MS || 5000);
const SUPABASE_INTERVAL_MS = Number(process.env.SUPABASE_INTERVAL_MS || 60000);

const state = {
  startedAt: new Date().toISOString(),
  sockets: {},
  current: null,
  errors: []
};

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function clamp(v, a = 0, b = 100) { return Math.max(a, Math.min(b, v)); }
function addError(err, context) {
  const item = { at: new Date().toISOString(), context, error: String(err) };
  state.errors.push(item);
  if (state.errors.length > 50) state.errors.shift();
  log.warn(item);
}
function socketHealth(name, patch) {
  state.sockets[name] = { ...(state.sockets[name] || {}), ...patch };
}

function pushTrade({ venue, market_type, symbol, price, qty, side, event_time_ms, trade_id = null }) {
  const p = num(price), q = num(qty), t = num(event_time_ms);
  if (!p || !q || !t || !['buy', 'sell'].includes(side)) return;
  const row = {
    event_time: new Date(t).toISOString(),
    ingested_at: new Date().toISOString(),
    event_time_ms: t,
    venue,
    market_type,
    symbol,
    price: p,
    qty: q,
    notional_usd: p * q,
    side,
    trade_id: String(trade_id ?? '')
  };
  flow.recordTrade(row);
  clickhouseWriter.enqueueTrade(row);
}

function pushBook({ venue, market_type, symbol, event_time_ms, bids, asks, sequence = null }) {
  if (!Array.isArray(bids) || !Array.isArray(asks) || !bids.length || !asks.length) return;
  const bestBid = num(bids[0]?.[0]);
  const bestAsk = num(asks[0]?.[0]);
  if (!bestBid || !bestAsk || bestAsk <= bestBid) return;
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10000;
  const t = num(event_time_ms) || Date.now();
  const row = {
    event_time: new Date(t).toISOString(),
    ingested_at: new Date().toISOString(),
    event_time_ms: t,
    venue,
    market_type,
    symbol,
    sequence: String(sequence ?? ''),
    bid_prices: bids.slice(0, 50).map(x => Number(x[0])),
    bid_sizes: bids.slice(0, 50).map(x => Number(x[1])),
    ask_prices: asks.slice(0, 50).map(x => Number(x[0])),
    ask_sizes: asks.slice(0, 50).map(x => Number(x[1])),
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: spreadBps
  };
  const key = `${venue}:${market_type}`;
  localBooks.set(key, row);
  void redisPublisher.publishBook(row);

  const last = lastBookSample.get(key) || 0;
  if (Date.now() - last >= BOOK_SAMPLE_MS) {
    lastBookSample.set(key, Date.now());
    clickhouseWriter.enqueueBook(row);
  }
}

function connectSocket(name, url, { onOpen, onMessage, onReset, appPing = null } = {}) {
  let ws;
  let closed = false;
  let attempt = 0;
  let pingTimer;
  let watchdog;

  const start = () => {
    if (closed) return;
    attempt += 1;
    socketHealth(name, { status: 'CONNECTING', attempt, url });
    onReset?.();
    ws = new WebSocket(url);

    ws.on('open', () => {
      attempt = 0;
      socketHealth(name, { status: 'LIVE', connected_at: new Date().toISOString(), last_message_at: null });
      try { onOpen?.(ws); } catch (err) { addError(err, `${name}:open`); }
      pingTimer = setInterval(() => {
        try {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (appPing) ws.send(JSON.stringify(appPing));
          else ws.ping();
        } catch (err) { addError(err, `${name}:ping`); }
      }, 20000);
      watchdog = setInterval(() => {
        const h = state.sockets[name];
        const last = h?.last_message_at ? Date.parse(h.last_message_at) : 0;
        if (last && Date.now() - last > 30000) {
          socketHealth(name, { status: 'STALE' });
          try { ws.terminate(); } catch {}
        }
      }, 10000);
    });

    ws.on('message', buf => {
      socketHealth(name, { status: 'LIVE', last_message_at: new Date().toISOString() });
      try { onMessage?.(JSON.parse(buf.toString()), ws); } catch (err) { addError(err, `${name}:message`); }
    });
    ws.on('error', err => addError(err, `${name}:socket`));
    ws.on('close', () => {
      clearInterval(pingTimer);
      clearInterval(watchdog);
      onReset?.();
      socketHealth(name, { status: 'DISCONNECTED', disconnected_at: new Date().toISOString() });
      setTimeout(start, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
    });
  };

  start();
  return () => {
    closed = true;
    clearInterval(pingTimer);
    clearInterval(watchdog);
    onReset?.();
    try { ws?.close(); } catch {}
  };
}

// Binance spot.
connectSocket('binance_spot_trade', 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade', {
  onMessage: m => pushTrade({ venue: 'Binance', market_type: 'spot', symbol: 'BTCUSDT', price: m.p, qty: m.q, side: m.m ? 'sell' : 'buy', event_time_ms: m.T, trade_id: m.a })
});
connectSocket('binance_spot_book', 'wss://stream.binance.com:9443/ws/btcusdt@depth20@100ms', {
  onMessage: m => pushBook({ venue: 'Binance', market_type: 'spot', symbol: 'BTCUSDT', event_time_ms: m.E || Date.now(), bids: m.bids || m.b || [], asks: m.asks || m.a || [], sequence: m.lastUpdateId || m.u })
});

// Binance USDT perpetual.
connectSocket('binance_perp_trade', 'wss://fstream.binance.com/ws/btcusdt@aggTrade', {
  onMessage: m => pushTrade({ venue: 'Binance', market_type: 'perp', symbol: 'BTCUSDT-PERP', price: m.p, qty: m.q, side: m.m ? 'sell' : 'buy', event_time_ms: m.T, trade_id: m.a })
});
connectSocket('binance_perp_book', 'wss://fstream.binance.com/ws/btcusdt@depth20@100ms', {
  onMessage: m => pushBook({ venue: 'Binance', market_type: 'perp', symbol: 'BTCUSDT-PERP', event_time_ms: m.E || Date.now(), bids: m.b || [], asks: m.a || [], sequence: m.u })
});

function bybitSocket(category, marketType) {
  const name = `bybit_${marketType}`;
  const reconstructor = new BybitBookReconstructor({ depth: 50 });
  connectSocket(name, `wss://stream.bybit.com/v5/public/${category}`, {
    appPing: { op: 'ping' },
    onReset: () => reconstructor.reset(),
    onOpen: ws => ws.send(JSON.stringify({ op: 'subscribe', args: ['publicTrade.BTCUSDT', 'orderbook.50.BTCUSDT'] })),
    onMessage: m => {
      if (m.topic === 'publicTrade.BTCUSDT') {
        for (const t of m.data || []) {
          pushTrade({ venue: 'Bybit', market_type: marketType, symbol: marketType === 'spot' ? 'BTCUSDT' : 'BTCUSDT-PERP', price: t.p, qty: t.v, side: String(t.S).toLowerCase() === 'buy' ? 'buy' : 'sell', event_time_ms: t.T || m.ts, trade_id: t.i });
        }
      }
      if (m.topic === 'orderbook.50.BTCUSDT') {
        const applied = reconstructor.applyMessage(m);
        if (!applied.book) {
          if (applied.status === 'WAITING_SNAPSHOT') socketHealth(name, { status: 'PARTIAL', book_status: applied.status });
          return;
        }
        const symbol = marketType === 'spot' ? 'BTCUSDT' : 'BTCUSDT-PERP';
        pushBook({ venue: 'Bybit', market_type: marketType, symbol, event_time_ms: m.cts || m.ts || Date.now(), bids: applied.book.bids, asks: applied.book.asks, sequence: applied.book.seq });
        socketHealth(name, { book_status: applied.status, book_update_id: applied.book.updateId, book_seq: applied.book.seq });
      }
    }
  });
}
bybitSocket('spot', 'spot');
bybitSocket('linear', 'perp');

function okxSocket(instId, marketType, includeTrades = true) {
  const name = `okx_${marketType}`;
  const args = [{ channel: 'books5', instId }];
  if (includeTrades) args.unshift({ channel: 'trades', instId });
  connectSocket(name, 'wss://ws.okx.com:8443/ws/v5/public', {
    appPing: 'ping',
    onOpen: ws => ws.send(JSON.stringify({ op: 'subscribe', args })),
    onMessage: m => {
      if (m.arg?.channel === 'trades' && includeTrades) {
        for (const t of m.data || []) {
          const qty = marketType === 'spot' ? t.sz : null;
          if (qty !== null) pushTrade({ venue: 'OKX', market_type: marketType, symbol: instId, price: t.px, qty, side: t.side, event_time_ms: t.ts, trade_id: t.tradeId });
        }
      }
      if (m.arg?.channel === 'books5') {
        for (const b of m.data || []) pushBook({ venue: 'OKX', market_type: marketType, symbol: instId, event_time_ms: b.ts || Date.now(), bids: b.bids || [], asks: b.asks || [], sequence: b.seqId });
      }
    }
  });
}
okxSocket('BTC-USDT', 'spot', true);
okxSocket('BTC-USDT-SWAP', 'perp', false); // Contract-size normalization required before perp trades enter CVD.

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function fetchBinanceDerivatives() {
  const [premium, oi, ticker] = await Promise.all([
    fetchJson('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    fetchJson('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'),
    fetchJson('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT')
  ]);
  const price = num(ticker.price);
  const contracts = num(oi.openInterest);
  return { status: 'LIVE', observed_at: new Date().toISOString(), price, oi_usd: price !== null && contracts !== null ? price * contracts : null, funding: num(premium.lastFundingRate), source_event_at: num(premium.time) || Date.now() };
}
async function fetchBybitDerivatives() {
  const [perp, spot] = await Promise.all([
    fetchJson('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT'),
    fetchJson('https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT')
  ]);
  const p = perp.result?.list?.[0], s = spot.result?.list?.[0];
  const price = num(p?.lastPrice), oiBase = num(p?.openInterest), oiValue = num(p?.openInterestValue);
  return { status: 'LIVE', observed_at: new Date().toISOString(), price, spot_price: num(s?.lastPrice), oi_usd: oiValue ?? (price !== null && oiBase !== null ? price * oiBase : null), funding: num(p?.fundingRate), source_event_at: Date.now() };
}
async function fetchOkxDerivatives() {
  const [oi, funding] = await Promise.all([
    fetchJson('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP'),
    fetchJson('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP')
  ]);
  const o = oi.data?.[0], f = funding.data?.[0];
  return { status: 'LIVE', observed_at: new Date().toISOString(), price: num(f?.markPx), oi_usd: num(o?.oiUsd), funding: num(f?.fundingRate), source_event_at: num(f?.ts) || Date.now() };
}

async function pollDerivatives() {
  const venues = [
    ['Binance', fetchBinanceDerivatives],
    ['Bybit', fetchBybitDerivatives],
    ['OKX', fetchOkxDerivatives]
  ];
  const results = await Promise.allSettled(venues.map(([, fn]) => fn()));
  for (let i = 0; i < results.length; i++) {
    const [venue] = venues[i];
    const result = results[i];
    if (result.status === 'fulfilled') derivativeState[venue] = result.value;
    else {
      const previous = derivativeState[venue];
      derivativeState[venue] = previous
        ? { ...previous, status: 'STALE', error: String(result.reason), failed_at: new Date().toISOString() }
        : { status: 'UNAVAILABLE', error: String(result.reason), failed_at: new Date().toISOString(), oi_usd: null, funding: null };
      addError(result.reason, `derivatives:${venue}`);
    }
  }
  void redisPublisher.publishDerivatives(derivativeState);
}

function computeComposite() {
  const books = [...localBooks.values()].filter(x => x.market_type === 'spot' && x.best_bid && x.best_ask && Date.now() - x.event_time_ms < 5000);
  if (!books.length) return null;
  const mids = books.map(x => ({ venue: x.venue, mid: (x.best_bid + x.best_ask) / 2, spread_bps: x.spread_bps }));
  const sorted = mids.map(x => x.mid).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const valid = mids.filter(x => Math.abs(x.mid - median) / median < 0.005);
  let numerator = 0, denominator = 0;
  for (const x of valid) {
    const weight = 1 / Math.max(Number(x.spread_bps || 2), 0.1);
    numerator += x.mid * weight;
    denominator += weight;
  }
  const price = numerator / denominator;
  const dispersion_bps = valid.length > 1 ? ((Math.max(...valid.map(x => x.mid)) - Math.min(...valid.map(x => x.mid))) / price) * 10000 : 0;
  return { price, venue_count: valid.length, dispersion_bps, venues: valid };
}

function buildState() {
  const composite = computeComposite();
  if (!composite) return null;
  const spot = { m1: flow.window('spot', 1), m5: flow.window('spot', 5), m15: flow.window('spot', 15), m60: flow.window('spot', 60) };
  const perp = { m1: flow.window('perp', 1), m5: flow.window('perp', 5), m15: flow.window('perp', 15), m60: flow.window('perp', 60) };
  const liveDerivatives = Object.values(derivativeState).filter(v => v?.status === 'LIVE' && v.oi_usd !== null);
  const totalOi = liveDerivatives.length ? liveDerivatives.reduce((a, v) => a + Number(v.oi_usd), 0) : null;
  const fundingRows = liveDerivatives.filter(v => v.funding !== null && v.funding !== undefined);
  const fundingOiWeighted = totalOi && fundingRows.length ? fundingRows.reduce((a, v) => a + Number(v.funding) * Number(v.oi_usd), 0) / fundingRows.reduce((a, v) => a + Number(v.oi_usd), 0) : null;

  const prior = state.current;
  const priceDeltaPct = prior?.price ? ((composite.price - prior.price) / prior.price) * 100 : null;
  const oiDeltaPct = prior?.open_interest_usd && totalOi !== null ? ((totalOi - prior.open_interest_usd) / prior.open_interest_usd) * 100 : null;
  let driver = 'UNCLEAR', confidence = 45;
  if (priceDeltaPct !== null) {
    const ps = Math.sign(priceDeltaPct), ss = Math.sign(spot.m5.delta_usd), pps = Math.sign(perp.m5.delta_usd);
    if (ss === ps && Math.abs(spot.m5.delta_usd) > Math.max(Math.abs(perp.m5.delta_usd) * 1.35, 5e6)) { driver = 'SPOT_LED'; confidence = 68; }
    else if (pps === ps && Math.abs(perp.m5.delta_usd) > Math.max(Math.abs(spot.m5.delta_usd) * 1.35, 5e6) && Math.abs(oiDeltaPct || 0) > 0.01) { driver = 'LEVERAGE_LED'; confidence = 72; }
    else if (ss || pps) { driver = 'MIXED'; confidence = 58; }
  }

  const socketRows = Object.values(state.sockets);
  const liveSockets = socketRows.filter(x => x.status === 'LIVE').length;
  const badSockets = socketRows.filter(x => ['STALE', 'DISCONNECTED', 'PARTIAL'].includes(x.status)).length;
  const quality = clamp(50 + liveSockets * 5 - badSockets * 7 - clickhouseWriter.health().quarantined_batches * 2, 20, 98);

  return {
    observed_at: new Date().toISOString(),
    price: composite.price,
    venue_count: composite.venue_count,
    venue_dispersion_bps: composite.dispersion_bps,
    spot,
    perp,
    open_interest_usd: totalOi,
    funding_oi_weighted: fundingOiWeighted,
    driver_classification: driver,
    driver_confidence: confidence,
    data_quality: quality,
    derivatives: structuredClone(derivativeState),
    source_health: {
      sockets: state.sockets,
      redis: redisPublisher.health(),
      clickhouse: clickhouseWriter.health()
    }
  };
}

async function publishState() {
  try {
    const next = buildState();
    if (!next) return;
    state.current = next;
    await redisPublisher.publishState(next);
  } catch (err) { addError(err, 'publishState'); }
}

async function persistSupabase() {
  if (!supabase || !state.current) return;
  const s = state.current;
  try {
    const row = {
      observed_at: s.observed_at,
      composite_price_usd: s.price,
      composite_method: 'persistent WebSocket collector spread-weighted spot composite',
      venue_count: s.venue_count,
      venue_dispersion_bps: s.venue_dispersion_bps,
      spot_cvd_usd_1m: s.spot.m1.delta_usd,
      spot_cvd_usd_5m: s.spot.m5.delta_usd,
      spot_cvd_usd_15m: s.spot.m15.delta_usd,
      spot_cvd_usd_1h: s.spot.m60.delta_usd,
      perp_cvd_usd_1m: s.perp.m1.delta_usd,
      perp_cvd_usd_5m: s.perp.m5.delta_usd,
      perp_cvd_usd_15m: s.perp.m15.delta_usd,
      perp_cvd_usd_1h: s.perp.m60.delta_usd,
      spot_perp_cvd_divergence_5m: s.spot.m5.delta_usd - s.perp.m5.delta_usd,
      open_interest_usd: s.open_interest_usd,
      funding_oi_weighted: s.funding_oi_weighted,
      driver_classification: s.driver_classification,
      driver_confidence: s.driver_confidence,
      data_quality: s.data_quality,
      freshness: { collector_ms: Date.now() - Date.parse(s.observed_at) },
      source_health: s.source_health,
      raw: { collector: 'websocket-v2-p1-hardened' }
    };
    const { error } = await supabase.from('btc_market_snapshots').insert(row);
    if (error) throw error;
  } catch (err) { addError(err, 'persistSupabase'); }
}

setInterval(() => void clickhouseWriter.flushTrades().catch(err => addError(err, 'clickhouse:trades')), 750).unref();
setInterval(() => void clickhouseWriter.flushBooks().catch(err => addError(err, 'clickhouse:books')), 1000).unref();
setInterval(() => void pollDerivatives(), REST_POLL_MS).unref();
setInterval(() => void publishState(), STATE_INTERVAL_MS).unref();
setInterval(() => void persistSupabase(), SUPABASE_INTERVAL_MS).unref();
void pollDerivatives();
void publishState();

fastify.get('/health', async () => ({
  ok: true,
  now: new Date().toISOString(),
  started_at: state.startedAt,
  redis: redisPublisher.health(),
  clickhouse: clickhouseWriter.health(),
  sockets: state.sockets,
  flow_buckets: flow.size(),
  last_state_at: state.current?.observed_at || null,
  errors: state.errors.slice(-10)
}));
fastify.get('/state', async () => state.current || { ok: false, status: 'WARMING_UP' });

const port = Number(process.env.PORT || 3000);
fastify.listen({ port, host: '0.0.0.0' }).then(() => log.info({ port }, 'BTC Global Intelligence collector running')).catch(err => { log.fatal(err); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log.info({ sig }, 'shutting down');
    await clickhouseWriter.flushAll();
    try { await redis.quit(); } catch {}
    try { await clickhouse.close(); } catch {}
    process.exit(0);
  });
}
