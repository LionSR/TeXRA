-- Migration: Add BYOK spending views and deduplicate relay/BYOK base logic
-- Purpose: Create a single usage_base view with version-aware deduplication
-- for ALL usage (relay + BYOK), then derive both relay and BYOK spending
-- views from it. This replaces relay_usage_base with a universal base.

-- ===========================================================================
-- Drop existing views (relay views depend on relay_usage_base)
-- ===========================================================================
DROP VIEW IF EXISTS public.relay_spending_totals CASCADE;
DROP VIEW IF EXISTS public.relay_spending_monthly CASCADE;
DROP VIEW IF EXISTS public.relay_spending_daily CASCADE;
DROP VIEW IF EXISTS public.relay_spending_by_model CASCADE;
DROP VIEW IF EXISTS public.relay_spending_summary CASCADE;
DROP VIEW IF EXISTS public.relay_usage_base CASCADE;

-- ===========================================================================
-- Add index for non-relay queries (relay index already exists)
-- ===========================================================================
CREATE INDEX IF NOT EXISTS idx_usage_logs_byok_version
ON public.usage_logs(used_relay, stream_id, extension_version)
WHERE used_relay IS NOT TRUE;

-- ===========================================================================
-- Universal base view: Version-aware deduplication for ALL usage
-- ===========================================================================
CREATE OR REPLACE VIEW public.usage_base
WITH (security_invoker = on)
AS
-- New clients (v0.35.4+): per-round deltas, keep all rows
WITH new_version_streams AS (
    SELECT *
    FROM public.usage_logs u
    WHERE u.stream_id IS NOT NULL
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
    WHERE u.stream_id IS NOT NULL
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
        ovr.batch_id,
        ovr.editor_type
    FROM old_version_ranked ovr
    WHERE stream_rank = 1
),
-- Streamless records: fall back to batch deduplication
remaining_streamless AS (
    SELECT *
    FROM public.usage_logs u
    WHERE u.stream_id IS NULL
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
        rb.batch_id,
        rb.editor_type
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

COMMENT ON VIEW public.usage_base IS
'Base view for all usage with version-aware deduplication. Filter on used_relay for relay/BYOK splits (ADMIN ONLY)';

-- ===========================================================================
-- Backward-compat alias so any ad-hoc queries still work
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_usage_base
WITH (security_invoker = on)
AS
SELECT * FROM public.usage_base WHERE used_relay = TRUE;

COMMENT ON VIEW public.relay_usage_base IS
'Relay-only slice of usage_base (backward-compat alias, ADMIN ONLY)';

-- ===========================================================================
-- Update get_user_monthly_relay_spend to use usage_base
-- ===========================================================================
CREATE OR REPLACE FUNCTION get_user_monthly_relay_spend(
  p_user_id UUID,
  p_month_start TIMESTAMPTZ
)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(r.cost), 0)
  FROM public.usage_base r
  WHERE r.used_relay = TRUE
    AND r.user_id = p_user_id
    AND r.logged_at >= p_month_start;
$$ LANGUAGE SQL STABLE;

-- ###########################################################################
-- RELAY SPENDING VIEWS (rebuilt on top of usage_base)
-- ###########################################################################

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
LEFT JOIN public.usage_base r
    ON p.user_id = r.user_id AND r.used_relay = TRUE
GROUP BY p.user_id, p.email, p.tier;

COMMENT ON VIEW public.relay_spending_summary IS
'Per-user relay spending totals (ADMIN ONLY)';

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
INNER JOIN public.usage_base r
    ON p.user_id = r.user_id AND r.used_relay = TRUE
GROUP BY p.user_id, p.email, p.tier, r.model, r.provider;

COMMENT ON VIEW public.relay_spending_by_model IS
'Relay spending by user and model (ADMIN ONLY)';

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
INNER JOIN public.usage_base r
    ON p.user_id = r.user_id AND r.used_relay = TRUE
GROUP BY p.user_id, p.email, DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_daily IS
'Daily relay spending per user (ADMIN ONLY)';

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
INNER JOIN public.usage_base r
    ON p.user_id = r.user_id AND r.used_relay = TRUE
GROUP BY p.user_id, p.email, p.tier, DATE_TRUNC('month', r.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_monthly IS
'Monthly relay spending per user (ADMIN ONLY)';

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
FROM public.usage_base r
WHERE r.used_relay = TRUE
GROUP BY DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE
ORDER BY day DESC;

COMMENT ON VIEW public.relay_spending_totals IS
'Daily global relay spending totals (ADMIN ONLY)';

-- ###########################################################################
-- BYOK SPENDING VIEWS (same structure, filtered on used_relay IS NOT TRUE)
-- ###########################################################################

CREATE OR REPLACE VIEW public.byok_spending_summary
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
LEFT JOIN public.usage_base r
    ON p.user_id = r.user_id AND r.used_relay IS NOT TRUE
GROUP BY p.user_id, p.email, p.tier;

COMMENT ON VIEW public.byok_spending_summary IS
'Per-user BYOK spending totals (ADMIN ONLY)';

CREATE OR REPLACE VIEW public.byok_spending_by_model
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
INNER JOIN public.usage_base r
    ON p.user_id = r.user_id AND r.used_relay IS NOT TRUE
GROUP BY p.user_id, p.email, p.tier, r.model, r.provider;

COMMENT ON VIEW public.byok_spending_by_model IS
'BYOK spending by user and model (ADMIN ONLY)';

CREATE OR REPLACE VIEW public.byok_spending_daily
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
INNER JOIN public.usage_base r
    ON p.user_id = r.user_id AND r.used_relay IS NOT TRUE
GROUP BY p.user_id, p.email, DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.byok_spending_daily IS
'Daily BYOK spending per user (ADMIN ONLY)';

CREATE OR REPLACE VIEW public.byok_spending_monthly
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
INNER JOIN public.usage_base r
    ON p.user_id = r.user_id AND r.used_relay IS NOT TRUE
GROUP BY p.user_id, p.email, p.tier, DATE_TRUNC('month', r.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.byok_spending_monthly IS
'Monthly BYOK spending per user (ADMIN ONLY)';

CREATE OR REPLACE VIEW public.byok_spending_totals
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
FROM public.usage_base r
WHERE r.used_relay IS NOT TRUE
GROUP BY DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE
ORDER BY day DESC;

COMMENT ON VIEW public.byok_spending_totals IS
'Daily global BYOK spending totals (ADMIN ONLY)';
