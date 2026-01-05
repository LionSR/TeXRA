-- Migration: Adjust relay spending views to use net input tokens
-- Purpose: Historic usage_logs entries may include input tokens that were served
-- from provider caches. Netting out cached_input_tokens ensures spending
-- analytics reflect actual billable input tokens even for past rows.

-- Helper expression for net input tokens
-- Use GREATEST() to avoid negative values if cached_input_tokens exceeds input_tokens
-- (possible with malformed data)

-- Drop existing views so we can change column shapes without replacement conflicts
DROP VIEW IF EXISTS public.relay_spending_totals CASCADE;
DROP VIEW IF EXISTS public.relay_spending_monthly CASCADE;
DROP VIEW IF EXISTS public.relay_spending_daily CASCADE;
DROP VIEW IF EXISTS public.relay_spending_by_model CASCADE;
DROP VIEW IF EXISTS public.relay_spending_summary CASCADE;

-- ===========================================================================
-- Update relay_spending_summary view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_summary AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    COUNT(u.id) AS total_requests,
    COALESCE(SUM(u.input_tokens), 0) AS total_input_tokens,
    COALESCE(SUM(GREATEST(u.input_tokens - COALESCE(u.cached_input_tokens, 0), 0)), 0)
      AS total_net_input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(u.cached_input_tokens), 0) AS total_cached_tokens,
    COALESCE(SUM(u.reasoning_tokens), 0) AS total_reasoning_tokens,
    COALESCE(SUM(u.cost), 0) AS total_cost_usd,
    MIN(u.logged_at) AS first_request_at,
    MAX(u.logged_at) AS last_request_at
FROM public.profiles p
LEFT JOIN public.usage_logs u
    ON p.user_id = u.user_id
    AND u.used_relay = TRUE
GROUP BY p.user_id, p.email, p.tier;

COMMENT ON VIEW public.relay_spending_summary IS
'Per-user relay spending totals (ADMIN ONLY - access via service role)';

-- ===========================================================================
-- Update relay_spending_by_model view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_by_model AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    u.model,
    u.provider,
    COUNT(u.id) AS request_count,
    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(GREATEST(u.input_tokens - COALESCE(u.cached_input_tokens, 0), 0)), 0)
      AS net_input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(u.cost), 0) AS cost_usd,
    AVG(u.response_time_ms) AS avg_response_time_ms
FROM public.profiles p
INNER JOIN public.usage_logs u
    ON p.user_id = u.user_id
    AND u.used_relay = TRUE
GROUP BY p.user_id, p.email, p.tier, u.model, u.provider;

COMMENT ON VIEW public.relay_spending_by_model IS
'Relay spending by user and model (ADMIN ONLY - access via service role)';

-- ===========================================================================
-- Update relay_spending_daily view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_daily AS
SELECT
    p.user_id,
    p.email,
    DATE_TRUNC('day', u.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    COUNT(u.id) AS request_count,
    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(GREATEST(u.input_tokens - COALESCE(u.cached_input_tokens, 0), 0)), 0)
      AS net_input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(u.cost), 0) AS cost_usd
FROM public.profiles p
INNER JOIN public.usage_logs u
    ON p.user_id = u.user_id
    AND u.used_relay = TRUE
GROUP BY p.user_id, p.email, DATE_TRUNC('day', u.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_daily IS
'Daily relay spending per user in UTC (ADMIN ONLY - access via service role)';

-- ===========================================================================
-- Update relay_spending_monthly view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_monthly AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    DATE_TRUNC('month', u.logged_at AT TIME ZONE 'UTC')::DATE AS month,
    COUNT(u.id) AS request_count,
    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(GREATEST(u.input_tokens - COALESCE(u.cached_input_tokens, 0), 0)), 0)
      AS net_input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(u.cached_input_tokens), 0) AS cached_tokens,
    COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
    COALESCE(SUM(u.cost), 0) AS cost_usd,
    COUNT(DISTINCT u.model) AS models_used,
    COUNT(DISTINCT u.provider) AS providers_used
FROM public.profiles p
INNER JOIN public.usage_logs u
    ON p.user_id = u.user_id
    AND u.used_relay = TRUE
GROUP BY p.user_id, p.email, p.tier, DATE_TRUNC('month', u.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_monthly IS
'Monthly relay spending per user in UTC for billing (ADMIN ONLY - access via service role)';

-- ===========================================================================
-- Update relay_spending_totals view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_totals AS
SELECT
    DATE_TRUNC('day', u.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    COUNT(DISTINCT u.user_id) AS active_users,
    COUNT(u.id) AS total_requests,
    COALESCE(SUM(u.input_tokens), 0) AS total_input_tokens,
    COALESCE(SUM(GREATEST(u.input_tokens - COALESCE(u.cached_input_tokens, 0), 0)), 0)
      AS total_net_input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(u.cost), 0) AS total_cost_usd,
    COUNT(DISTINCT u.model) AS models_used
FROM public.usage_logs u
WHERE u.used_relay = TRUE
GROUP BY DATE_TRUNC('day', u.logged_at AT TIME ZONE 'UTC')::DATE
ORDER BY day DESC;

COMMENT ON VIEW public.relay_spending_totals IS
'Daily global relay spending totals in UTC (ADMIN ONLY - access via service role)';
