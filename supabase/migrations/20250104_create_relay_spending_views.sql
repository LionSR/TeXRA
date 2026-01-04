-- Migration: Create relay spending analytics views
--
-- These views provide pre-computed spending summaries for relay usage.
-- ADMIN ONLY: Accessed via service role key, not exposed to regular users.
--
-- IMPORTANT: This migration requires the profiles table to exist.
-- Run after the initial schema setup that creates profiles.

-- ============================================================================
-- STEP 1: Add indexes for relay spending queries
-- ============================================================================
-- Partial index for relay-only filtering
CREATE INDEX IF NOT EXISTS idx_usage_logs_used_relay
ON public.usage_logs(used_relay)
WHERE used_relay = TRUE;

-- Compound index for spending limit checks (user + time range + relay filter)
CREATE INDEX IF NOT EXISTS idx_usage_logs_user_relay_logged
ON public.usage_logs(user_id, logged_at)
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
'Per-user relay spending totals (ADMIN ONLY - access via service role)';

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
'Relay spending by user and model (ADMIN ONLY - access via service role)';

-- ============================================================================
-- STEP 4: Create relay_spending_daily view
-- ============================================================================
-- Daily aggregates for trend analysis (UTC timezone for consistency)
CREATE OR REPLACE VIEW public.relay_spending_daily AS
SELECT
    p.user_id,
    p.email,
    DATE_TRUNC('day', u.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    COUNT(u.id) AS request_count,
    COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(u.cost), 0) AS cost_usd
FROM public.profiles p
INNER JOIN public.usage_logs u
    ON p.user_id = u.user_id
    AND u.used_relay = TRUE
GROUP BY p.user_id, p.email, DATE_TRUNC('day', u.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_daily IS
'Daily relay spending per user in UTC (ADMIN ONLY - access via service role)';

-- ============================================================================
-- STEP 5: Create relay_spending_monthly view
-- ============================================================================
-- Monthly summaries for billing cycles (UTC timezone for consistent billing)
CREATE OR REPLACE VIEW public.relay_spending_monthly AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    DATE_TRUNC('month', u.logged_at AT TIME ZONE 'UTC')::DATE AS month,
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
GROUP BY p.user_id, p.email, p.tier, DATE_TRUNC('month', u.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_monthly IS
'Monthly relay spending per user in UTC for billing (ADMIN ONLY - access via service role)';

-- ============================================================================
-- STEP 6: Create relay_spending_totals view (global admin overview)
-- ============================================================================
-- Global totals across all users (UTC timezone for consistency)
CREATE OR REPLACE VIEW public.relay_spending_totals AS
SELECT
    DATE_TRUNC('day', u.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    COUNT(DISTINCT u.user_id) AS active_users,
    COUNT(u.id) AS total_requests,
    COALESCE(SUM(u.input_tokens), 0) AS total_input_tokens,
    COALESCE(SUM(u.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(u.cost), 0) AS total_cost_usd,
    COUNT(DISTINCT u.model) AS models_used
FROM public.usage_logs u
WHERE u.used_relay = TRUE
GROUP BY DATE_TRUNC('day', u.logged_at AT TIME ZONE 'UTC')::DATE
ORDER BY day DESC;

COMMENT ON VIEW public.relay_spending_totals IS
'Daily global relay spending totals in UTC (ADMIN ONLY - access via service role)';

-- ============================================================================
-- STEP 7: Permissions - ADMIN ONLY via service role
-- ============================================================================
-- These views are NOT granted to authenticated users.
-- Access them only via service role key in Edge Functions or admin scripts.
-- This prevents regular users from seeing other users' spending data.

-- No GRANT statements - service role has implicit access to all objects.

-- ============================================================================
-- VERIFICATION QUERIES (run with service role key)
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
