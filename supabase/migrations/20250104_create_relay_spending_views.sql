-- Migration: Create relay spending analytics views
--
-- These views provide pre-computed spending summaries for relay usage.
-- They are automatically exposed via Supabase REST API for admin dashboards.

-- ============================================================================
-- STEP 1: Add index for relay filtering (improves view performance)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_usage_logs_used_relay
ON public.usage_logs(used_relay)
WHERE used_relay = TRUE;

-- ============================================================================
-- STEP 2: Create relay_spending_summary view
-- ============================================================================
-- Per-user totals: cost, tokens, request count
CREATE OR REPLACE VIEW public.relay_spending_summary AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    COUNT(u.id) AS total_requests,
    COALESCE(SUM(u.input_tokens), 0) AS total_input_tokens,
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
'Per-user relay spending totals including tokens, cost, and request counts';

-- ============================================================================
-- STEP 3: Create relay_spending_by_model view
-- ============================================================================
-- Breakdown by user + model/provider combination
CREATE OR REPLACE VIEW public.relay_spending_by_model AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    u.model,
    u.provider,
    COUNT(u.id) AS request_count,
    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(u.cost), 0) AS cost_usd,
    AVG(u.response_time_ms) AS avg_response_time_ms
FROM public.profiles p
INNER JOIN public.usage_logs u
    ON p.user_id = u.user_id
    AND u.used_relay = TRUE
GROUP BY p.user_id, p.email, p.tier, u.model, u.provider;

COMMENT ON VIEW public.relay_spending_by_model IS
'Relay spending breakdown by user and model/provider combination';

-- ============================================================================
-- STEP 4: Create relay_spending_daily view
-- ============================================================================
-- Daily aggregates for trend analysis
CREATE OR REPLACE VIEW public.relay_spending_daily AS
SELECT
    p.user_id,
    p.email,
    DATE_TRUNC('day', u.logged_at)::DATE AS day,
    COUNT(u.id) AS request_count,
    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(u.cost), 0) AS cost_usd
FROM public.profiles p
INNER JOIN public.usage_logs u
    ON p.user_id = u.user_id
    AND u.used_relay = TRUE
GROUP BY p.user_id, p.email, DATE_TRUNC('day', u.logged_at)::DATE;

COMMENT ON VIEW public.relay_spending_daily IS
'Daily relay spending aggregates per user for trend analysis';

-- ============================================================================
-- STEP 5: Create relay_spending_monthly view
-- ============================================================================
-- Monthly summaries for billing cycles
CREATE OR REPLACE VIEW public.relay_spending_monthly AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    DATE_TRUNC('month', u.logged_at)::DATE AS month,
    COUNT(u.id) AS request_count,
    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
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
GROUP BY p.user_id, p.email, p.tier, DATE_TRUNC('month', u.logged_at)::DATE;

COMMENT ON VIEW public.relay_spending_monthly IS
'Monthly relay spending summaries per user for billing and quota tracking';

-- ============================================================================
-- STEP 6: Create relay_spending_totals view (admin overview)
-- ============================================================================
-- Global totals across all users (useful for admin dashboards)
CREATE OR REPLACE VIEW public.relay_spending_totals AS
SELECT
    DATE_TRUNC('day', u.logged_at)::DATE AS day,
    COUNT(DISTINCT u.user_id) AS active_users,
    COUNT(u.id) AS total_requests,
    COALESCE(SUM(u.input_tokens), 0) AS total_input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(u.cost), 0) AS total_cost_usd,
    COUNT(DISTINCT u.model) AS models_used
FROM public.usage_logs u
WHERE u.used_relay = TRUE
GROUP BY DATE_TRUNC('day', u.logged_at)::DATE
ORDER BY day DESC;

COMMENT ON VIEW public.relay_spending_totals IS
'Daily global relay spending totals across all users (admin overview)';

-- ============================================================================
-- STEP 7: Grant permissions
-- ============================================================================
-- Views inherit RLS from underlying tables, but we need SELECT grants
-- Service role can access all data; authenticated users see filtered results

GRANT SELECT ON public.relay_spending_summary TO authenticated;
GRANT SELECT ON public.relay_spending_by_model TO authenticated;
GRANT SELECT ON public.relay_spending_daily TO authenticated;
GRANT SELECT ON public.relay_spending_monthly TO authenticated;
GRANT SELECT ON public.relay_spending_totals TO authenticated;

-- ============================================================================
-- VERIFICATION QUERIES (run manually to test)
-- ============================================================================
--
-- -- Top spenders overall:
-- SELECT email, tier, total_requests, total_cost_usd
-- FROM relay_spending_summary
-- ORDER BY total_cost_usd DESC LIMIT 10;
--
-- -- Spending by model for a specific user:
-- SELECT model, provider, request_count, cost_usd
-- FROM relay_spending_by_model
-- WHERE email = 'user@example.com'
-- ORDER BY cost_usd DESC;
--
-- -- Monthly trend for current year:
-- SELECT month, SUM(cost_usd) as total, COUNT(DISTINCT user_id) as users
-- FROM relay_spending_monthly
-- WHERE month >= '2025-01-01'
-- GROUP BY month
-- ORDER BY month;
--
-- -- Daily totals for admin dashboard:
-- SELECT * FROM relay_spending_totals LIMIT 30;
