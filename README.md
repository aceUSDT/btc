# BTC Global Intelligence

Dedicated repository for the BTC Global Intelligence market-data and trade-intelligence platform.

This repository is intentionally isolated from the Estimations Tool project.

## Data plane

- Persistent exchange WebSocket collector
- Redis live-state cache
- ClickHouse tick / sampled order-book history
- Supabase durable intelligence state
- CoinGlass enrichment when configured

## Integrity rules

- Missing or stale inputs reduce confidence; they are never silently substituted.
- Bybit order-book deltas are reconstructed against a local snapshot before publication.
- ClickHouse trade and book batches are flushed independently so a failure in one sink cannot duplicate the other.
- Redis retries and offline queuing are bounded so a Redis outage cannot exhaust collector memory.
- Secrets remain server-side only.
