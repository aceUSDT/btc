export const SIGNAL_FAMILIES = Object.freeze({
  structure: ['price','ohlcv','prev_day_week_month_levels','swings','vwap','anchored_vwap','volume_profile','breakout_retest','range_deviation','psych_levels','cme_gaps','session_levels'],
  spot_flow: ['spot_cvd','taker_buy_sell','net_delta','volume_acceleration','large_trades','orderbook_imbalance','absorption','exhaustion'],
  derivatives: ['perp_cvd','open_interest','oi_delta','funding','oi_weighted_funding','volume_weighted_funding','basis','positioning'],
  liquidations: ['liquidation_orders','liquidation_velocity','liquidation_acceleration','liquidation_map','liquidation_heatmap','clusters'],
  institutional: ['us_spot_etf_flows','hk_spot_etf_flows','etf_holdings','etf_aum','etf_premium_discount','coinbase_premium','cme_futures','cme_basis','cme_options','cot'],
  options: ['dvol','atm_iv','realized_vol','term_structure','skew','risk_reversal','put_call_volume','put_call_oi','strike_oi','expiry_oi','gamma_context','expected_move','max_pain'],
  onchain: ['exchange_flows','exchange_reserves','realized_metrics','mvrv','sopr','nupl','sth_lth','miner_flows','hash_rate','difficulty','whale_transfers'],
  stablecoins: ['usdt_peg','usdc_peg','stablecoin_supply','exchange_balances','mint_burn','netflows'],
  macro: ['fed','rate_probabilities','balance_sheet','tga','rrp','sofr','cpi','ppi','payrolls','unemployment','jolts','gdp','retail_sales','ism','treasury_yields','real_yields','curve','auctions'],
  cross_asset: ['dxy','nasdaq','sp500','vix','move','gold','wti','brent','usdjpy','usdcnh','credit','mstr','coin'],
  prediction_markets: ['polymarket','kalshi'],
  news: ['government','company','exchange','wire','crypto_media','event_calendar'],
  engine: ['regime','dynamic_weighting','bull_score','bear_score','data_quality','trade_confidence','event_risk','setup_gating','explainability','alerts']
});

// Direct feeds are the low-latency primary layer. CoinGlass is used as the
// broad-venue aggregation and reconciliation layer so the engine can represent
// long-tail exchanges without pretending every venue exposes an equally good
// public WebSocket API.
export const DIRECT_VENUES = Object.freeze([
  'Binance','Bybit','OKX','Coinbase','Kraken','Bitfinex','Bitstamp','Gemini',
  'Bitget','Gate','KuCoin','MEXC','HTX','Crypto.com','WhiteBIT','CoinEx','BingX',
  'Hyperliquid','dYdX','Deribit'
]);

export const COINGLASS_FUTURES_UNIVERSE = Object.freeze([
  'OKX','Binance','HTX','Bitmex','Bitfinex','Bybit','Deribit','Gate','Kraken',
  'KuCoin','CME','Bitget','dYdX','CoinEx','BingX','Coinbase','Gemini',
  'Crypto.com','Hyperliquid','Bitunix','MEXC','WhiteBIT','Aster','Lighter',
  'EdgeX','Drift','Paradex','Extended','ApeX Omni'
]);

export const REQUIRED_SOURCE_GROUPS = Object.freeze([
  'direct_exchange_ws',
  'coinglass_all_exchange',
  'deribit_options',
  'etf',
  'onchain',
  'macro_primary',
  'cross_asset',
  'prediction_markets',
  'news_primary'
]);

export const FRESHNESS_THRESHOLDS_MS = Object.freeze({
  raw_trade: 2_000,
  orderbook: 3_000,
  liquidation_order: 3_000,
  derived_cvd: 5_000,
  open_interest: 15_000,
  funding: 60_000,
  liquidation_map: 30_000,
  options: 60_000,
  cross_asset: 60_000,
  prediction_market: 120_000,
  macro_release: 300_000,
  etf: 3_600_000,
  onchain: 900_000,
  news: 300_000
});

export function freshnessStatus(ageMs, thresholdMs) {
  if (!Number.isFinite(ageMs)) return 'UNAVAILABLE';
  if (ageMs <= thresholdMs) return 'LIVE';
  if (ageMs <= thresholdMs * 3) return 'DELAYED';
  return 'STALE';
}
