CREATE DATABASE IF NOT EXISTS btc;

-- Remove only the prototype objects created by the earlier BTC collector.
-- They live inside this dedicated BTC ClickHouse service and are no longer
-- referenced by the hardened V2 collector. Dropping them also releases the
-- small Railway volume from the prototype's oversized raw-tick backlog.
DROP VIEW IF EXISTS btc.minute_flow_mv;
DROP TABLE IF EXISTS btc.minute_flow_mv;
DROP TABLE IF EXISTS btc.minute_flow;
DROP TABLE IF EXISTS btc.orderbook_snapshots;
DROP TABLE IF EXISTS btc.raw_trades;
DROP TABLE IF EXISTS btc.collector_health;

-- V2 tables deliberately use new names so an old table engine can never be
-- silently inherited after an upgrade.
CREATE TABLE IF NOT EXISTS btc.raw_trades_v2
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
TTL event_time + INTERVAL 30 MINUTE DELETE
SETTINGS index_granularity = 8192;

ALTER TABLE btc.raw_trades_v2 MODIFY TTL event_time + INTERVAL 30 MINUTE DELETE;

CREATE TABLE IF NOT EXISTS btc.orderbook_snapshots_v2
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
TTL event_time + INTERVAL 2 HOUR DELETE
SETTINGS index_granularity = 8192;

ALTER TABLE btc.orderbook_snapshots_v2 MODIFY TTL event_time + INTERVAL 2 HOUR DELETE;

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
TTL observed_at + INTERVAL 7 DAY DELETE;
