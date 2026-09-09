# BTC Global Intelligence

Dedicated repository for the BTC Global Intelligence market-data and trade-intelligence platform.

## Single authoritative engine

**Railway is the only authoritative compute/ingestion engine.** Supabase is durable storage and audit history; it must not run a competing BTC calculation pipeline.

The production V5 runtime is `collector/src/v5.js` and combines:

- Persistent low-latency direct exchange WebSockets
- Redis live-state cache/pubsub
- ClickHouse raw trade / sampled order-book history plus compact 1-minute intelligence history
- CoinGlass V4 broad-exchange aggregation and reconciliation
- Deribit options / volatility analytics
- ETF flow and AUM context
- Free on-chain fallback via Coin Metrics Community + mempool.space, with optional Glassnode premium enrichment
- Fear & Greed sentiment context
- Macro/rates/liquidity context via FRED and primary release sources
- Cross-asset context
- Polymarket and Kalshi prediction-market context
- Primary-source news monitoring
- Regime classification, independent bull/bear scoring, setup gating and explainability
- Supabase persistence for snapshots, signals, setups, alerts and longer-lived features

## Exchange coverage

Direct WebSocket feeds cover the major economically material BTC venues in the V5 adapter set, including Binance, Bybit, OKX, Coinbase, Kraken, Hyperliquid, Deribit, Bitfinex and Gate where supported by the adapter and market type.

The broad-venue layer dynamically reconciles against CoinGlass-supported BTC spot venues and the full CoinGlass futures universe, including OKX, Binance, HTX, BitMEX, Bitfinex, Bybit, Deribit, Gate, Kraken, KuCoin, CME, Bitget, dYdX, CoinEx, BingX, Coinbase, Gemini, Crypto.com, Hyperliquid, Bitunix, MEXC, WhiteBIT and additional supported venues.

This design intentionally does **not** pretend every exchange exposes an equally reliable public WebSocket API. Material venues are collected directly; long-tail venues are captured through the normalized all-exchange reconciliation layer and can be promoted to direct adapters when their market share or data quality warrants it.

## Signal families

The engine contract covers price/structure, spot order flow, derivatives/leverage, liquidations/liquidity maps, ETF/CME/institutional flows, options/volatility, on-chain/stablecoins, macro/rates/liquidity, cross-assets/energy, sentiment, prediction markets, news/event risk, regime classification, adaptive scoring, trade gating and explainability.

Missing, delayed, estimated or partial fields remain explicit in source health and reduce data/trade confidence. The engine may return **NO_TRADE** when independent signal families do not provide enough edge.

## Data integrity rules

- Direct exchange feeds are preferred for low-latency market microstructure; CoinGlass is reconciliation/enrichment, not an unquestioned primary source.
- Missing/stale inputs are never silently substituted.
- Aggregated CVD uses normalized USD taker notional and retains spot/perp separation.
- Contract-valued venues must be normalized before entering cross-venue CVD.
- Liquidation executions and liquidation-map/heatmap positioning are distinct data classes.
- Source timestamps, receive timestamps, age/status and source health are carried into the intelligence state.
- Bybit order-book deltas are reconstructed against a local snapshot before publication.
- ClickHouse trade and book batches flush independently; ambiguous write failures are quarantined rather than blindly duplicated.
- Redis retry/offline behavior is bounded.
- Secrets remain server-side only.
- Supabase is a durable sink, not a second market-data engine.
- Fear & Greed is low-weight contextual sentiment and never a standalone trade trigger.
- Glassnode-only cohort/entity-adjusted metrics are never fabricated when entitlement is absent.

## Required credentials

Core direct public exchange feeds do not require credentials. Production should configure:

- `COINGLASS_API_KEY` — all-exchange aggregation, liquidations, ETF and selected on-chain data
- `FRED_API_KEY` — macro/rates/liquidity history
- `SUPABASE_URL` + `SUPABASE_SECRET_KEY` — durable persistence only
- `SUPABASE_SERVICE_ROLE_KEY` — compatibility alias for the current V5 runtime
- `GLASSNODE_API_KEY` — optional premium MVRV/SOPR/NUPL/STH-LTH metrics when the plan permits

`/health`, `/state` and `/intelligence` expose the authoritative Railway engine state.

## Production deployment

V5 production deployment trigger: 2026-09-09. Deployment is valid only after Railway reports the V5 startup command, healthcheck success, and live source/sink smoke tests.
