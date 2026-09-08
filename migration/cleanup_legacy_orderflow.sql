-- RUN ONLY AFTER the dedicated BTC Supabase project is live, historical rows are copied,
-- collector writes are verified, the ChatGPT automation points at the new project,
-- and a rollback export exists.

select cron.unschedule('btc-intelligence-minute')
where exists (select 1 from cron.job where jobname='btc-intelligence-minute');

select cron.unschedule(jobid)
from cron.job
where command ilike '%btc_prune_history%';

drop view if exists public.btc_current_intelligence;
drop view if exists public.btc_latest_state;
drop function if exists public.btc_prune_history();
drop function if exists public.btc_get_secret(text);

drop table if exists public.btc_alerts cascade;
drop table if exists public.btc_setups cascade;
drop table if exists public.btc_signal_state cascade;
drop table if exists public.btc_liquidation_clusters cascade;
drop table if exists public.btc_market_snapshots cascade;
drop table if exists public.btc_exchange_snapshots cascade;
drop table if exists public.btc_data_sources cascade;

-- Delete the legacy CoinGlass Vault secret only after it exists and is verified
-- in the dedicated BTC project. Never expose the secret value during migration.
