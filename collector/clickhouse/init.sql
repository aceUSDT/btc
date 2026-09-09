CREATE DATABASE IF NOT EXISTS btc;

-- Remove only prototype/legacy objects from the earlier collector generations.
DROP VIEW IF EXISTS btc.minute_flow_mv;
DROP TABLE IF EXISTS btc.minute_flow_mv;
DROP TABLE IF EXISTS btc.minute_flow;
DROP TABLE IF EXISTS btc.orderbook_snapshots;
DROP TABLE IF EXISTS btc.raw_trades;
DROP TABLE IF EXISTS btc.collector_health;

-- Production recovery: raw V2 trade/book history is intentionally ephemeral.
-- On the current 500 MB Railway volume we keep only a very short diagnostic
-- window here; Redis + in-memory engines provide current state and Supabase is
-- the durable mirror. Recreating these two raw tables frees any filled parts
-- before V5 starts. Durable intelligence history is NOT dropped.
DROP VIEW IF EXISTS btc.minute_flow_v2;
DROP TABLE IF EXISTS btc.raw_trades_v2 SYNC;
DROP TABLE IF EXISTS btc.orderbook_snapshots_v2 SYNC;

CREATE TABLE btc.raw_trades_v2
(
    event_time DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    event_time_ms UInt64,
    venue LowCardinality(String),
    market_type LowCardinality(String),
    symbol LowCardinality(String),
    price Float64,
    qty Float64,
    notional_usd Float64,
    side Enum8('buy' = 1, 'sell' = -1),
    trade_id String
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (venue, market_type, symbol, event_time_ms, trade_id)
TTL event_time + INTERVAL 5 MINUTE DELETE
SETTINGS index_granularity = 8192;

CREATE TABLE btc.orderbook_snapshots_v2
(
    event_time DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC'),
    event_time_ms UInt64,
    venue LowCardinality(String),
    market_type LowCardinality(String),
    symbol LowCardinality(String),
    sequence String,
    bid_prices Array(Float64),
    bid_sizes Array(Float64),
    ask_prices Array(Float64),
    ask_sizes Array(Float64),
    best_bid Nullable(Float64),
    best_ask Nullable(Float64),
    spread_bps Nullable(Float64)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (venue, market_type, symbol, event_time_ms, sequence)
TTL event_time + INTERVAL 5 MINUTE DELETE
SETTINGS index_granularity = 8192;

CREATE OR REPLACE VIEW btc.minute_flow_v2 AS
SELECT
    toStartOfMinute(event_time) AS minute,
    venue,
    market_type,
    symbol,
    sumIf(notional_usd, side = 'buy') AS taker_buy_usd,
    sumIf(notional_usd, side = 'sell') AS taker_sell_usd,
    sum(if(side = 'buy', notional_usd, -notional_usd)) AS delta_usd,
    count() AS trades
FROM btc.raw_trades_v2 FINAL
GROUP BY minute, venue, market_type, symbol;

-- Compact one-row-per-minute feature history. Supabase is the durable archive;
-- ClickHouse keeps a bounded 30-day calibration window on the 500 MB volume.
CREATE TABLE IF NOT EXISTS btc.intelligence_1m_v3
(
    minute DateTime('UTC'),
    ingested_at DateTime64(3, 'UTC'),
    price_usd Float64,
    spot_cvd_1m Nullable(Float64),
    spot_cvd_5m Nullable(Float64),
    perp_cvd_1m Nullable(Float64),
    perp_cvd_5m Nullable(Float64),
    open_interest_usd Nullable(Float64),
    funding_oi_weighted Nullable(Float64),
    long_liq_5m_usd Nullable(Float64),
    short_liq_5m_usd Nullable(Float64),
    bull_score Nullable(Float64),
    bear_score Nullable(Float64),
    trade_confidence Nullable(Float64),
    data_quality Nullable(Float64),
    regime LowCardinality(String),
    driver LowCardinality(String),
    event_risk LowCardinality(String),
    payload String
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(minute)
ORDER BY minute
TTL minute + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;

ALTER TABLE btc.intelligence_1m_v3 MODIFY TTL minute + INTERVAL 30 DAY DELETE;

CREATE TABLE IF NOT EXISTS btc.collector_health_v2
(
    observed_at DateTime64(3, 'UTC'),
    service LowCardinality(String),
    status LowCardinality(String),
    payload String
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(observed_at)
ORDER BY (service, observed_at)
TTL observed_at + INTERVAL 2 DAY DELETE;

ALTER TABLE btc.collector_health_v2 MODIFY TTL observed_at + INTERVAL 2 DAY DELETE;
