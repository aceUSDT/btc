import { COINGLASS_FUTURES_UNIVERSE, freshnessStatus, FRESHNESS_THRESHOLDS_MS } from './coverage.js';

const CG_BASE = 'https://open-api-v4.coinglass.com';
const DERIBIT_BASE = 'https://www.deribit.com/api/v2';
const KALSHI_BASE = 'https://external-api.kalshi.com/trade-api/v2';
const POLY_GAMMA = 'https://gamma-api.polymarket.com';
const FRED_BASE = 'https://api.stlouisfed.org/fred';

const BTC_TERMS = /(bitcoin|btc|crypto|federal reserve|fed|fomc|cpi|inflation|rates|interest rate|recession|treasury|oil|iran|tariff|liquidity)/i;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function mean(xs) {
  const ys = xs.map(num).filter(v => v !== null);
  return ys.length ? ys.reduce((a,b)=>a+b,0) / ys.length : null;
}
function sum(xs) { return xs.map(num).filter(v => v !== null).reduce((a,b)=>a+b,0); }
function nowIso() { return new Date().toISOString(); }
function msTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

async function fetchAny(url, { headers = {}, timeoutMs = 8000, as = 'json' } = {}) {
  const started = Date.now();
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { accept: '*/*', 'user-agent': 'BTC-Global-Intelligence/3.0', ...headers }, signal: c.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${url}: ${text.slice(0,180)}`);
    let data = text;
    if (as === 'json') {
      try { data = JSON.parse(text); } catch { throw new Error(`non-json response ${url}: ${text.slice(0,120)}`); }
    }
    return { ok: true, data, latency_ms: Date.now() - started, observed_at: nowIso() };
  } finally { clearTimeout(timer); }
}

async function safe(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { source: name, status: 'LIVE', latency_ms: Date.now() - started, observed_at: nowIso(), ...value };
  } catch (err) {
    return { source: name, status: 'UNAVAILABLE', latency_ms: Date.now() - started, observed_at: nowIso(), error: String(err) };
  }
}

function qs(params = {}) {
  const p = new URLSearchParams();
  for (const [k,v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  return p.toString();
}

async function cg(key, path, params = {}) {
  if (!key) throw new Error('COINGLASS_API_KEY is not configured');
  const r = await fetchAny(`${CG_BASE}${path}?${qs(params)}`, { headers: { 'CG-API-KEY': key }, timeoutMs: 10_000 });
  if (String(r.data?.code ?? '0') !== '0') throw new Error(`CoinGlass ${path}: ${r.data?.msg || r.data?.code}`);
  return { ...r, data: r.data?.data };
}

function parseCvdRows(rows = []) {
  return rows.map(x => ({
    time: msTime(x.time ?? x.timestamp),
    buy: num(x.agg_taker_buy_vol ?? x.taker_buy_vol ?? x.buy_volume_usd),
    sell: num(x.agg_taker_sell_vol ?? x.taker_sell_vol ?? x.sell_volume_usd)
  })).filter(x => x.time).map(x => ({ ...x, delta: (x.buy || 0) - (x.sell || 0) })).sort((a,b)=>a.time-b.time);
}
function rolling(rows, minutes) {
  const cutoff = Date.now() - minutes * 60_000 - 10_000;
  const chosen = rows.filter(x => x.time >= cutoff);
  return chosen.length ? chosen.reduce((a,x)=>a+x.delta,0) : null;
}

function parseLiquidations(rows = [], minutes = 5) {
  const cutoff = Date.now() - minutes * 60_000 - 10_000;
  const recent = rows.filter(x => (msTime(x.time ?? x.timestamp) || 0) >= cutoff);
  return {
    long_usd: sum(recent.map(x => x.aggregated_long_liquidation_usd ?? x.long_liquidation_usd)),
    short_usd: sum(recent.map(x => x.aggregated_short_liquidation_usd ?? x.short_liquidation_usd)),
    bars: recent.length
  };
}

function parseLiquidationMap(data, price) {
  const candidates = [];
  const walk = (node, parentKey = null) => {
    if (Array.isArray(node)) {
      if (node.length >= 2 && Number.isFinite(Number(node[0])) && Number.isFinite(Number(node[1]))) {
        candidates.push({ price: Number(node[0]), notional_usd: Math.abs(Number(node[1])) });
      } else node.forEach(x => walk(x, parentKey));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k,v] of Object.entries(node)) {
      const kp = Number(k);
      if (Number.isFinite(kp) && Array.isArray(v)) {
        let nt = 0;
        const scan = z => {
          if (Array.isArray(z)) {
            if (z.length >= 2 && Number.isFinite(Number(z[1]))) nt += Math.abs(Number(z[1]));
            else z.forEach(scan);
          }
        };
        scan(v);
        if (nt > 0) candidates.push({ price: kp, notional_usd: nt });
      } else walk(v, k);
    }
  };
  walk(data);
  const filtered = candidates.filter(x => x.price > price * 0.85 && x.price < price * 1.15 && x.notional_usd > 0);
  const dedup = new Map();
  for (const x of filtered) dedup.set(x.price, Math.max(dedup.get(x.price) || 0, x.notional_usd));
  const all = [...dedup].map(([p,n])=>({ price:p, notional_usd:n, distance_pct:(p-price)/price*100 })).sort((a,b)=>b.notional_usd-a.notional_usd);
  const above = all.filter(x=>x.price>price).sort((a,b)=>b.notional_usd-a.notional_usd)[0] || null;
  const below = all.filter(x=>x.price<price).sort((a,b)=>b.notional_usd-a.notional_usd)[0] || null;
  return { above, below, clusters: all.slice(0,50) };
}

export async function collectCoinGlassAllExchange(price) {
  return safe('coinglass_all_exchange', async () => {
    const key = process.env.COINGLASS_API_KEY || '';
    const exchangeList = COINGLASS_FUTURES_UNIVERSE.join(',');
    const [supported, spotPairs, futuresMarket, oiExchange, oiHistory, spotCvd, perpCvd, liq, liqMap, fundingHistory, spotPairsMarket, etf, hkEtf, etfAssets] = await Promise.all([
      cg(key, '/api/futures/supported-exchanges'),
      cg(key, '/api/spot/supported-exchange-pairs'),
      cg(key, '/api/futures/coins-markets'),
      cg(key, '/api/futures/open-interest/exchange-list', { symbol: 'BTC' }),
      cg(key, '/api/futures/open-interest/exchange-history-chart', { symbol: 'BTC', range: '1h', unit: 'usd' }),
      cg(key, '/api/spot/aggregated-cvd/history', { exchange_list: exchangeList, symbol:'BTC', interval:'1m', limit:70, unit:'usd' }),
      cg(key, '/api/futures/aggregated-cvd/history', { exchange_list: exchangeList, symbol:'BTC', interval:'1m', limit:70, unit:'usd' }),
      cg(key, '/api/futures/liquidation/aggregated-history', { exchange_list: exchangeList, symbol:'BTC', interval:'1m', limit:70 }),
      cg(key, '/api/futures/liquidation/aggregated-map', { symbol:'BTC', range:'1d' }),
      cg(key, '/api/futures/funding-rate/oi-weight-history', { symbol:'BTC', interval:'1h', limit:200 }),
      cg(key, '/api/spot/pairs-markets'),
      cg(key, '/api/etf/bitcoin/flow-history'),
      cg(key, '/api/hk-etf/bitcoin/flow-history'),
      cg(key, '/api/etf/bitcoin/net-assets/history')
    ]);

    const futuresBtc = (futuresMarket.data || []).find(x => String(x.symbol).toUpperCase() === 'BTC') || null;
    const spotRows = parseCvdRows(spotCvd.data || []);
    const perpRows = parseCvdRows(perpCvd.data || []);
    const liq1 = parseLiquidations(liq.data || [], 1);
    const liq5 = parseLiquidations(liq.data || [], 5);
    const map = parseLiquidationMap(liqMap.data, price);
    const spotVenueRows = (spotPairsMarket.data || []).filter(x => String(x.symbol || '').toUpperCase().includes('BTC'));
    const latestEtf = (etf.data || []).slice().sort((a,b)=>(msTime(b.timestamp)||0)-(msTime(a.timestamp)||0))[0] || null;
    const latestHkEtf = (hkEtf.data || []).slice().sort((a,b)=>(msTime(b.timestamp)||0)-(msTime(a.timestamp)||0))[0] || null;
    const latestAssets = (etfAssets.data || []).slice().sort((a,b)=>(msTime(b.timestamp)||0)-(msTime(a.timestamp)||0))[0] || null;
    const fundingRows = (fundingHistory.data || []).map(x => num(x.close)).filter(x=>x!==null);
    const sortedFunding = [...fundingRows].sort((a,b)=>a-b);
    const currentFunding = fundingRows.at(-1) ?? null;
    const pct = currentFunding === null || !sortedFunding.length ? null : (sortedFunding.filter(x=>x<=currentFunding).length / sortedFunding.length) * 100;

    const supportedFutures = Array.isArray(supported.data) ? supported.data : [];
    const spotSupported = spotPairs.data && typeof spotPairs.data === 'object' ? Object.entries(spotPairs.data)
      .filter(([,pairs]) => Array.isArray(pairs) && pairs.some(p => String(p.base_asset).toUpperCase()==='BTC'))
      .map(([venue])=>venue) : [];

    return {
      status: 'LIVE',
      coverage: {
        futures_supported: supportedFutures,
        futures_count: supportedFutures.length,
        spot_btc_supported: spotSupported,
        spot_btc_count: spotSupported.length,
        requested_futures_universe: COINGLASS_FUTURES_UNIVERSE
      },
      market: futuresBtc,
      open_interest: {
        total_usd: num(futuresBtc?.open_interest_usd),
        exchange_rows: oiExchange.data || [],
        history_chart: oiHistory.data || null
      },
      funding: {
        oi_weighted: num(futuresBtc?.avg_funding_rate_by_oi),
        volume_weighted: num(futuresBtc?.avg_funding_rate_by_vol),
        history_close: fundingRows.slice(-200),
        percentile: pct
      },
      flow: {
        spot_cvd_1m: rolling(spotRows,1), spot_cvd_5m: rolling(spotRows,5), spot_cvd_15m: rolling(spotRows,15), spot_cvd_1h: rolling(spotRows,60),
        perp_cvd_1m: rolling(perpRows,1), perp_cvd_5m: rolling(perpRows,5), perp_cvd_15m: rolling(perpRows,15), perp_cvd_1h: rolling(perpRows,60),
        spot_venue_rows: spotVenueRows
      },
      liquidations: {
        long_1m_usd: liq1.long_usd, short_1m_usd: liq1.short_usd,
        long_5m_usd: liq5.long_usd, short_5m_usd: liq5.short_usd,
        velocity_usd_per_min: (liq5.long_usd + liq5.short_usd) / 5,
        map
      },
      etf: {
        us_latest: latestEtf,
        hk_latest: latestHkEtf,
        net_assets_latest: latestAssets
      }
    };
  });
}

export async function collectDeribitOptions() {
  return safe('deribit_options', async () => {
    const end = Date.now();
    const start = end - 6 * 60 * 60 * 1000;
    const [opts, futs, dvol] = await Promise.all([
      fetchAny(`${DERIBIT_BASE}/public/get_book_summary_by_currency?currency=BTC&kind=option`),
      fetchAny(`${DERIBIT_BASE}/public/get_book_summary_by_currency?currency=BTC&kind=future`),
      fetchAny(`${DERIBIT_BASE}/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${end}&resolution=60`)
    ]);
    const options = opts.data?.result || [];
    const futures = futs.data?.result || [];
    const dv = dvol.data?.result?.data || [];
    const dvolClose = dv.length ? num(dv.at(-1)?.[4]) : null;
    const parsed = options.map(o => {
      const name = String(o.instrument_name || '');
      const parts = name.split('-');
      const strike = num(parts.at(-2));
      const type = parts.at(-1) === 'C' ? 'call' : parts.at(-1) === 'P' ? 'put' : null;
      const expiry = parts.length >= 4 ? parts[1] : null;
      return { name, strike, type, expiry, oi:num(o.open_interest), volume_usd:num(o.volume_usd), mark_iv:num(o.mark_iv), underlying_price:num(o.underlying_price), bid:num(o.bid_price), ask:num(o.ask_price) };
    });
    const calls = parsed.filter(x=>x.type==='call'), puts = parsed.filter(x=>x.type==='put');
    const callOi = sum(calls.map(x=>x.oi)), putOi = sum(puts.map(x=>x.oi));
    const callVol = sum(calls.map(x=>x.volume_usd)), putVol = sum(puts.map(x=>x.volume_usd));
    const byExpiry = {};
    for (const x of parsed) {
      const k = x.expiry || 'unknown';
      byExpiry[k] ||= { oi:0, volume_usd:0, calls_oi:0, puts_oi:0 };
      byExpiry[k].oi += x.oi || 0;
      byExpiry[k].volume_usd += x.volume_usd || 0;
      if (x.type==='call') byExpiry[k].calls_oi += x.oi || 0;
      if (x.type==='put') byExpiry[k].puts_oi += x.oi || 0;
    }
    const expiries = Object.entries(byExpiry).map(([expiry,v])=>({expiry,...v})).sort((a,b)=>b.oi-a.oi);
    const atmIvRows = parsed.filter(x=>x.mark_iv!==null && x.underlying_price && x.strike && Math.abs(x.strike-x.underlying_price)/x.underlying_price < 0.03);
    const atmIv = mean(atmIvRows.map(x=>x.mark_iv));
    return {
      dvol: dvolClose,
      atm_iv: atmIv,
      option_oi: callOi + putOi,
      put_call_oi_ratio: callOi ? putOi / callOi : null,
      put_call_volume_ratio: callVol ? putVol / callVol : null,
      expiries: expiries.slice(0,20),
      active_options: parsed.length,
      futures: futures.map(x=>({ instrument_name:x.instrument_name, oi:num(x.open_interest), volume_usd:num(x.volume_usd), mark:num(x.mark_price), underlying:num(x.underlying_price), funding_8h:num(x.funding_8h) })).slice(0,50)
    };
  });
}

export async function collectPredictionMarkets() {
  return safe('prediction_markets', async () => {
    const polyQueries = ['bitcoin','BTC','Federal Reserve','CPI','inflation','recession'];
    const polyResults = [];
    for (const q of polyQueries) {
      try {
        const r = await fetchAny(`${POLY_GAMMA}/public-search?${qs({ q, events_status:'active', limit_per_type:10, search_profiles:false })}`);
        for (const e of r.data?.events || []) {
          if (!BTC_TERMS.test(`${e.title||''} ${e.description||''}`)) continue;
          polyResults.push({ id:e.id, title:e.title, liquidity:num(e.liquidity), volume:num(e.volume), volume24h:num(e.volume24hr), open_interest:num(e.openInterest), end_date:e.endDate, markets:(e.markets||[]).slice(0,20).map(m=>({id:m.id,question:m.question,outcomes:m.outcomes,outcome_prices:m.outcomePrices,volume:num(m.volume),liquidity:num(m.liquidity)})) });
        }
      } catch {}
    }
    const polyMap = new Map(polyResults.map(x=>[x.id,x]));

    const kalshi = [];
    let cursor = null;
    for (let page=0; page<5; page++) {
      const r = await fetchAny(`${KALSHI_BASE}/markets?${qs({ status:'open', limit:100, cursor })}`);
      for (const m of r.data?.markets || []) {
        const text = `${m.title||''} ${m.subtitle||''} ${m.yes_sub_title||''} ${m.no_sub_title||''} ${m.event_ticker||''}`;
        if (BTC_TERMS.test(text)) kalshi.push({ ticker:m.ticker, event_ticker:m.event_ticker, title:m.title || m.subtitle || text, yes_bid:num(m.yes_bid_dollars), yes_ask:num(m.yes_ask_dollars), last:num(m.last_price_dollars), volume_24h:num(m.volume_24h_fp), open_interest:num(m.open_interest_fp), close_time:m.close_time });
      }
      cursor = r.data?.cursor;
      if (!cursor) break;
    }
    return { polymarket:[...polyMap.values()].slice(0,50), kalshi:kalshi.slice(0,100) };
  });
}

async function fredSeries(seriesId, key, limit = 12) {
  if (!key) throw new Error('FRED_API_KEY is not configured');
  const r = await fetchAny(`${FRED_BASE}/series/observations?${qs({ series_id:seriesId, api_key:key, file_type:'json', sort_order:'desc', limit })}`);
  return (r.data?.observations || []).map(x=>({ date:x.date, value:num(x.value), realtime_start:x.realtime_start, realtime_end:x.realtime_end }));
}

export async function collectMacro() {
  return safe('macro_primary', async () => {
    const key = process.env.FRED_API_KEY || '';
    const series = {
      fed_funds:'DFF', sofr:'SOFR', us2y:'DGS2', us10y:'DGS10', real10y:'DFII10',
      tga:'WTREGEN', rrp:'RRPONTSYD', fed_balance_sheet:'WALCL', unemployment:'UNRATE', payrolls:'PAYEMS',
      cpi:'CPIAUCSL', core_cpi:'CPILFESL', ppi:'PPIACO', retail_sales:'RSAFS', oil_wti:'DCOILWTICO', oil_brent:'DCOILBRENTEU',
      usd_jpy:'DEXJPUS', usdcnh:'DEXCHUS'
    };
    const entries = await Promise.allSettled(Object.entries(series).map(async ([k,id]) => [k, await fredSeries(id,key,12)]));
    const data = {};
    for (const r of entries) if (r.status==='fulfilled') data[r.value[0]] = r.value[1];
    const latest = {};
    for (const [k,rows] of Object.entries(data)) latest[k] = rows.find(x=>x.value!==null) || null;
    return { latest, history:data };
  });
}

export async function collectCrossAssets() {
  return safe('cross_asset', async () => {
    const symbols = {
      dxy:'DX-Y.NYB', nasdaq:'^IXIC', sp500:'^GSPC', vix:'^VIX', gold:'GC=F', wti:'CL=F', brent:'BZ=F',
      usdjpy:'JPY=X', usdcnh:'CNH=X', mstr:'MSTR', coin:'COIN'
    };
    const out = {};
    const rs = await Promise.allSettled(Object.entries(symbols).map(async ([key,symbol]) => {
      const r = await fetchAny(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`);
      const z = r.data?.chart?.result?.[0];
      const meta = z?.meta || {};
      const quote = z?.indicators?.quote?.[0] || {};
      const closes = (quote.close || []).filter(v=>num(v)!==null).map(Number);
      return [key,{symbol,price:num(meta.regularMarketPrice) ?? closes.at(-1) ?? null,prev_close:num(meta.chartPreviousClose),currency:meta.currency,exchange:meta.exchangeName,observed_at:nowIso()}];
    }));
    for (const r of rs) if (r.status==='fulfilled') out[r.value[0]] = r.value[1];
    if (!Object.keys(out).length) throw new Error('no cross-asset feeds available');
    return out;
  });
}

function parseRss(xml, source) {
  const items = [];
  const blocks = String(xml).match(/<item[\s\S]*?<\/item>/gi) || String(xml).match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const text = (b, tag) => {
    const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,'i'));
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim() : null;
  };
  for (const b of blocks.slice(0,50)) {
    const title = text(b,'title') || '';
    const description = text(b,'description') || text(b,'summary') || '';
    if (!BTC_TERMS.test(`${title} ${description}`)) continue;
    items.push({ source, title, description:description.slice(0,700), published_at:text(b,'pubDate') || text(b,'updated') || text(b,'published'), link:text(b,'link') });
  }
  return items;
}

export async function collectNews() {
  return safe('news_primary', async () => {
    const feeds = [
      ['Federal Reserve','https://www.federalreserve.gov/feeds/press_all.xml'],
      ['BLS','https://www.bls.gov/feed/bls_latest.rss'],
      ['SEC','https://www.sec.gov/news/pressreleases.rss'],
      ['CFTC','https://www.cftc.gov/PressRoom/PressReleases/rss']
    ];
    const all = [];
    const rs = await Promise.allSettled(feeds.map(async ([name,url]) => {
      const r = await fetchAny(url,{as:'text',timeoutMs:7000});
      return parseRss(r.data,name);
    }));
    for (const r of rs) if (r.status==='fulfilled') all.push(...r.value);
    return { items:all.slice(0,100) };
  });
}

export async function collectOnchain() {
  return safe('onchain', async () => {
    const key = process.env.COINGLASS_API_KEY || '';
    const jobs = [];
    if (key) {
      jobs.push(cg(key,'/api/exchange/balance/list',{symbol:'BTC'}).then(x=>['exchange_balances',x.data]));
      jobs.push(cg(key,'/api/chain/v2/whale-transfer',{symbol:'BTC'}).then(x=>['whale_transfers',x.data]));
    }
    jobs.push(fetchAny('https://api.blockchain.info/charts/hash-rate?timespan=30days&format=json').then(x=>['hash_rate',x.data]));
    jobs.push(fetchAny('https://api.blockchain.info/charts/difficulty?timespan=30days&format=json').then(x=>['difficulty',x.data]));
    const rs = await Promise.allSettled(jobs);
    const out = {};
    for (const r of rs) if (r.status==='fulfilled') out[r.value[0]] = r.value[1];
    if (!Object.keys(out).length) throw new Error('no on-chain feeds available');
    if (process.env.GLASSNODE_API_KEY) out.glassnode = { status:'CONFIGURED', note:'Glassnode advanced MVRV/SOPR/NUPL/STH-LTH adapter credential present; endpoint activation is plan-dependent.' };
    else out.glassnode = { status:'UNAVAILABLE', note:'Set GLASSNODE_API_KEY for MVRV/SOPR/NUPL/STH-LTH premium metrics.' };
    return out;
  });
}

export class ExternalIntelligenceHub {
  constructor({ getPrice }) {
    this.getPrice = getPrice;
    this.state = {};
    this.timers = [];
    this.running = false;
  }
  async refreshFast() {
    const price = Number(this.getPrice?.()) || 0;
    const [cgx,deribit,cross] = await Promise.all([collectCoinGlassAllExchange(price), collectDeribitOptions(), collectCrossAssets()]);
    this.state.coinglass = cgx;
    this.state.options = deribit;
    this.state.cross_asset = cross;
  }
  async refreshMedium() {
    const [pred,news,onchain] = await Promise.all([collectPredictionMarkets(), collectNews(), collectOnchain()]);
    this.state.prediction_markets = pred;
    this.state.news = news;
    this.state.onchain = onchain;
  }
  async refreshSlow() { this.state.macro = await collectMacro(); }
  start() {
    if (this.running) return;
    this.running = true;
    void this.refreshFast(); void this.refreshMedium(); void this.refreshSlow();
    this.timers.push(setInterval(()=>void this.refreshFast(), Number(process.env.EXTERNAL_FAST_MS || 30_000)));
    this.timers.push(setInterval(()=>void this.refreshMedium(), Number(process.env.EXTERNAL_MEDIUM_MS || 120_000)));
    this.timers.push(setInterval(()=>void this.refreshSlow(), Number(process.env.EXTERNAL_SLOW_MS || 300_000)));
    for (const t of this.timers) t.unref?.();
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers=[]; this.running=false; }
  snapshot() {
    const out = structuredClone(this.state);
    for (const v of Object.values(out)) {
      if (!v?.observed_at) continue;
      const age = Date.now() - Date.parse(v.observed_at);
      const threshold = v.source === 'macro_primary' ? FRESHNESS_THRESHOLDS_MS.macro_release : v.source === 'onchain' ? FRESHNESS_THRESHOLDS_MS.onchain : v.source === 'prediction_markets' ? FRESHNESS_THRESHOLDS_MS.prediction_market : v.source === 'news_primary' ? FRESHNESS_THRESHOLDS_MS.news : 60_000;
      v.age_ms = age;
      if (v.status === 'LIVE') v.status = freshnessStatus(age, threshold);
    }
    return out;
  }
}
