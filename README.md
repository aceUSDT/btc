# BTC Global Intelligence

Dedicated repository for the BTC Global Intelligence market-data and trade-intelligence platform.

## Single authoritative engine

**Railway is the only authoritative compute/ingestion engine.** Supabase is durable storage and audit history; it must not run a competing BTC calculation pipeline.

The v3 runtime is `collector/src/v3.js` and combines:

- Persistent low-latency direct exchange WebSockets
- Redis live-state cache/pubsub
- ClickHouse raw trade / sampled order-book history plus compact 1-minute intelligence history
- CoinGlass V4 broad-exchange aggregation and reconciliation
- Deribit options / volatility analytics
- ETF flow and AUM context
- On-chain / whale / exchange-balance context
- Macro/rates/liquidity context
- Cross-asset context
- Polymarket and Kalshi prediction-market context
- Primary-source news monitoring
- Regime classification, independent bull/bear scoring, setup gating and explainability
- Supabase persistence for snapshots, signals, setups, alerts and longer-lived features

## Exchange coverage

Direct WebSocket feeds currently include Binance, Bybit, OKX, Coinbase, Kraken, Hyperliquid and Deribit. Direct feeds are the low-latency primary layer.

The broad-venue layer dynamically reconciles against CoinGlass-supported BTC spot venues and the full CoinGlass futures universe, including OKX, Binance, HTX, BitMEX, Bitfinex, Bybit, Deribit, Gate, Kraken, KuCoin, CME, Bitget, dYdX, CoinEx, BingX, Coinbase, Gemini, Crypto.com, Hyperliquid, Bitunix, MEXC, WhiteBIT, Aster, Lighter, EdgeX, Drift, Paradex, Extended and ApeX Omni.

This design intentionally does **not** pretend every exchange exposes an equally reliable public WebSocket API. Material venues are collected directly; long-tail venues are captured through the normalized all-exchange reconciliation layer and can be promoted to direct adapters when their market share or data quality warrants it.

## Signal families

The engine contract covers price/structure, spot order flow, derivatives/leverage, liquidations/liquidity maps, ETF/CME/institutional flows, options/volatility, on-chain/stablecoins, macro/rates/liquidity, cross-assets/energy, prediction markets, news/event risk, regime classification, adaptive scoring, trade gating and explainability.

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

## Required credentials

Core direct public exchange feeds do not require credentials. Production should configure:

- `COINGLASS_API_KEY` — all-exchange aggregation, liquidations, ETF and selected on-chain data
- `FRED_API_KEY` — official macro/rates/liquidity history
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — durable persistence only
- `GLASSNODE_API_KEY` — optional premium MVRV/SOPR/NUPL/STH-LTH metrics when the plan permits

`/health`, `/state` and `/intelligence` expose the authoritative Railway engine state.
