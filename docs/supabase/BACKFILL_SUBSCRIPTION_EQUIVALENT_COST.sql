-- One-off backfill: list-price equivalent cost for historical subscription
-- usage rows.
--
-- Subscription rounds were logged with cost 0 (the client prices them through
-- zeroed subscription overrides). From this change's deploy onward the
-- log-usage edge function stores the list-price equivalent at ingest
-- (supabase/functions/log-usage/equivalentCost.ts); this script fills in the
-- rows that predate it.
--
-- Formula matches equivalentCost.ts / the client's computeStandardPrice:
--   input(cache-miss)·in + cached·in·0.1 + (output + reasoning)·out, per 1M.
-- Prices snapshotted from llm-zoo@1.25.0 (the version the edge functions
-- pin); every distinct model in subscription_usage_logs as of 2026-08-06 is
-- listed. Rows whose model is missing from the price list are left untouched
-- and reported by the verification query below.
--
-- Idempotent: only rows with cost = 0 are updated, and a backfilled row has
-- cost > 0 (all listed prices are nonzero), so re-running is a no-op.

BEGIN;

WITH prices(model, input_price, output_price) AS (
  VALUES
    ('gpt-5.6-sol',            5.0,  30.0),
    ('gpt-5.6-terra',          2.0,  12.0),
    ('gpt-5.6-luna',           0.2,   1.2),
    ('gpt-5.5-2026-04-23',     5.0,  30.0),
    ('gpt-5.5',                5.0,  30.0),
    ('gpt-5.4-2026-03-05',     2.5,  15.0),
    ('gpt-5.4-mini-2026-03-17', 0.75, 4.5)
)
UPDATE public.subscription_usage_logs AS logs
SET cost = ROUND(
  (
    logs.input_tokens * prices.input_price
    + COALESCE(logs.cached_input_tokens, 0) * prices.input_price * 0.1
    + (logs.output_tokens + COALESCE(logs.reasoning_tokens, 0)) * prices.output_price
  )::numeric / 1e6,
  6
)
FROM prices
WHERE logs.model = prices.model
  AND logs.cost = 0;

COMMIT;

-- Verification: models still at cost 0 (should be empty, or name models that
-- need a price added above).
SELECT model, COUNT(*) AS rows_without_cost
FROM public.subscription_usage_logs
WHERE cost = 0
GROUP BY model
ORDER BY rows_without_cost DESC;
