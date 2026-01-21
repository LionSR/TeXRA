-- Migration: Add extension version awareness to relay spending views
-- Purpose: Handle behavioral change in v0.35.4 where client switched from
-- sending accumulated totals to per-round deltas.
--
-- Before v0.35.4: Client sent accumulated totals each round (use MAX to get final)
-- From v0.35.4+: Client sends per-round deltas (use SUM to get total)
--
-- This applies to BOTH workflow and tool-use agents equally, since the
-- UsageMonitor change affected all agent types.
--
-- Aggregation logic:
--   < v0.35.4 (or NULL): MAX per stream for ALL agents (accumulated totals)
--   >= v0.35.4: SUM all rows for ALL agents (per-round deltas)

-- Drop existing views so column layout changes are accepted before rebuilding
DROP VIEW IF EXISTS public.relay_spending_totals CASCADE;
DROP VIEW IF EXISTS public.relay_spending_monthly CASCADE;
DROP VIEW IF EXISTS public.relay_spending_daily CASCADE;
DROP VIEW IF EXISTS public.relay_spending_by_model CASCADE;
DROP VIEW IF EXISTS public.relay_spending_summary CASCADE;
DROP VIEW IF EXISTS public.relay_usage_base CASCADE;

-- ===========================================================================
-- Add index for version-based queries
-- ===========================================================================
CREATE INDEX IF NOT EXISTS idx_usage_logs_relay_version
ON public.usage_logs(used_relay, stream_id, extension_version)
WHERE used_relay = TRUE;

-- ===========================================================================
-- Base view: Version-aware relay usage with deduplication
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_usage_base
WITH (security_invoker = on)
AS
-- New clients (v0.35.4+): per-round deltas, keep all rows
WITH new_version_streams AS (
    SELECT *
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.stream_id IS NOT NULL
      AND u.extension_version >= '0.35.4'
),
-- Old clients (< v0.35.4 or NULL): accumulated totals, use MAX per stream
old_version_ranked AS (
    SELECT
        u.*,
        ROW_NUMBER() OVER (
            PARTITION BY u.user_id, u.stream_id
            ORDER BY
                COALESCE(u.cost, 0) DESC,
                COALESCE(u.input_tokens, 0) DESC,
                COALESCE(u.output_tokens, 0) DESC,
                u.logged_at DESC,
                u.created_at DESC,
                u.id DESC
        ) AS stream_rank
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.stream_id IS NOT NULL
      AND (u.extension_version < '0.35.4' OR u.extension_version IS NULL)
),
old_version_streams AS (
    SELECT
        ovr.id,
        ovr.user_id,
        ovr.logged_at,
        ovr.created_at,
        ovr.model,
        ovr.provider,
        ovr.agent_name,
        ovr.agent_category,
        ovr.is_multiple_output,
        ovr.input_tokens,
        ovr.output_tokens,
        ovr.cached_input_tokens,
        ovr.reasoning_tokens,
        ovr.cost,
        ovr.response_time_ms,
        ovr.used_relay,
        ovr.stream_id,
        ovr.extension_version,
        ovr.batch_id
    FROM old_version_ranked ovr
    WHERE stream_rank = 1
),
-- Streamless records: fall back to batch deduplication
remaining_streamless AS (
    SELECT *
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.stream_id IS NULL
),
ranked_batches AS (
    SELECT
        u.*,
        ROW_NUMBER() OVER (
            PARTITION BY u.user_id, u.batch_id
            ORDER BY
                COALESCE(u.cost, 0) DESC,
                COALESCE(u.input_tokens, 0) DESC,
                COALESCE(u.output_tokens, 0) DESC,
                u.logged_at DESC,
                u.created_at DESC,
                u.id DESC
        ) AS batch_rank
    FROM remaining_streamless u
    WHERE u.batch_id IS NOT NULL
),
deduped_batches AS (
    SELECT
        rb.id,
        rb.user_id,
        rb.logged_at,
        rb.created_at,
        rb.model,
        rb.provider,
        rb.agent_name,
        rb.agent_category,
        rb.is_multiple_output,
        rb.input_tokens,
        rb.output_tokens,
        rb.cached_input_tokens,
        rb.reasoning_tokens,
        rb.cost,
        rb.response_time_ms,
        rb.used_relay,
        rb.stream_id,
        rb.extension_version,
        rb.batch_id
    FROM ranked_batches rb
    WHERE batch_rank = 1
)
SELECT * FROM new_version_streams
UNION ALL
SELECT * FROM old_version_streams
UNION ALL
SELECT * FROM deduped_batches
UNION ALL
SELECT *
FROM remaining_streamless u
WHERE u.batch_id IS NULL;

COMMENT ON VIEW public.relay_usage_base IS
'Base view for relay usage with version-aware deduplication (ADMIN ONLY)';

-- ===========================================================================
-- Update get_user_monthly_relay_spend to use base view
-- ===========================================================================
CREATE OR REPLACE FUNCTION get_user_monthly_relay_spend(
  p_user_id UUID,
  p_month_start TIMESTAMPTZ
)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(r.cost), 0)
  FROM public.relay_usage_base r
  WHERE r.user_id = p_user_id
    AND r.logged_at >= p_month_start;
$$ LANGUAGE SQL STABLE;

-- ===========================================================================
-- Update relay_spending_summary view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_summary
WITH (security_invoker = on)
AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    COUNT(r.id) AS total_requests,
    COALESCE(SUM(r.input_tokens + COALESCE(r.cached_input_tokens, 0)), 0)
      AS total_input_tokens,
    COALESCE(SUM(r.input_tokens), 0) AS total_net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(r.cached_input_tokens), 0) AS total_cached_tokens,
    COALESCE(SUM(r.reasoning_tokens), 0) AS total_reasoning_tokens,
    COALESCE(SUM(r.cost), 0) AS total_cost_usd,
    MIN(r.logged_at) AS first_request_at,
    MAX(r.logged_at) AS last_request_at
FROM public.profiles p
LEFT JOIN public.relay_usage_base r
    ON p.user_id = r.user_id
GROUP BY p.user_id, p.email, p.tier;

COMMENT ON VIEW public.relay_spending_summary IS
'Per-user relay spending totals with version-aware aggregation (ADMIN ONLY)';

-- ===========================================================================
-- Update relay_spending_by_model view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_by_model
WITH (security_invoker = on)
AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    r.model,
    r.provider,
    COUNT(r.id) AS request_count,
    COALESCE(SUM(r.input_tokens + COALESCE(r.cached_input_tokens, 0)), 0)
      AS input_tokens,
    COALESCE(SUM(r.input_tokens), 0) AS net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(r.cost), 0) AS cost_usd,
    AVG(r.response_time_ms) AS avg_response_time_ms
FROM public.profiles p
INNER JOIN public.relay_usage_base r
    ON p.user_id = r.user_id
GROUP BY p.user_id, p.email, p.tier, r.model, r.provider;

COMMENT ON VIEW public.relay_spending_by_model IS
'Relay spending by user and model with version-aware aggregation (ADMIN ONLY)';

-- ===========================================================================
-- Update relay_spending_daily view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_daily
WITH (security_invoker = on)
AS
SELECT
    p.user_id,
    p.email,
    DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    COUNT(r.id) AS request_count,
    COALESCE(SUM(r.input_tokens + COALESCE(r.cached_input_tokens, 0)), 0)
      AS input_tokens,
    COALESCE(SUM(r.input_tokens), 0) AS net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(r.cost), 0) AS cost_usd
FROM public.profiles p
INNER JOIN public.relay_usage_base r
    ON p.user_id = r.user_id
GROUP BY p.user_id, p.email, DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_daily IS
'Daily relay spending per user with version-aware aggregation (ADMIN ONLY)';

-- ===========================================================================
-- Update relay_spending_monthly view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_monthly
WITH (security_invoker = on)
AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    DATE_TRUNC('month', r.logged_at AT TIME ZONE 'UTC')::DATE AS month,
    COUNT(r.id) AS request_count,
    COALESCE(SUM(r.input_tokens + COALESCE(r.cached_input_tokens, 0)), 0)
      AS input_tokens,
    COALESCE(SUM(r.input_tokens), 0) AS net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(r.cached_input_tokens), 0) AS cached_tokens,
    COALESCE(SUM(r.reasoning_tokens), 0) AS reasoning_tokens,
    COALESCE(SUM(r.cost), 0) AS cost_usd,
    COUNT(DISTINCT r.model) AS models_used,
    COUNT(DISTINCT r.provider) AS providers_used
FROM public.profiles p
INNER JOIN public.relay_usage_base r
    ON p.user_id = r.user_id
GROUP BY p.user_id, p.email, p.tier, DATE_TRUNC('month', r.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_monthly IS
'Monthly relay spending per user with version-aware aggregation (ADMIN ONLY)';

-- ===========================================================================
-- Update relay_spending_totals view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_totals
WITH (security_invoker = on)
AS
SELECT
    DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    COUNT(DISTINCT r.user_id) AS active_users,
    COUNT(r.id) AS total_requests,
    COALESCE(SUM(r.input_tokens + COALESCE(r.cached_input_tokens, 0)), 0)
      AS total_input_tokens,
    COALESCE(SUM(r.input_tokens), 0) AS total_net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(r.cost), 0) AS total_cost_usd,
    COUNT(DISTINCT r.model) AS models_used
FROM public.relay_usage_base r
GROUP BY DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE
ORDER BY day DESC;

COMMENT ON VIEW public.relay_spending_totals IS
'Daily global relay spending totals with version-aware aggregation (ADMIN ONLY)';
