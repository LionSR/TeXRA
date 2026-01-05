-- Migration: Deduplicate relay spending views by latest batch entries
-- Purpose: Analytics should reflect the most recent record for each batch_id
-- without modifying existing usage_logs rows. We keep the original data intact
-- and rebuild the relay spending views to aggregate over a deduplicated set
-- where only the latest entry per (user_id, batch_id) is counted. Unbatched
-- rows (batch_id IS NULL) are included as-is.

-- Drop existing views so column layout changes are accepted before rebuilding
DROP VIEW IF EXISTS public.relay_spending_totals CASCADE;
DROP VIEW IF EXISTS public.relay_spending_monthly CASCADE;
DROP VIEW IF EXISTS public.relay_spending_daily CASCADE;
DROP VIEW IF EXISTS public.relay_spending_by_model CASCADE;
DROP VIEW IF EXISTS public.relay_spending_summary CASCADE;

-- Helper CTE used in all relay spending views
--   - deduped_batches: picks the latest row per (user_id, batch_id)
--   - relay_logs: combines deduped batched rows with all unbatched rows
-- The ORDER BY prefers most recent logged_at, then created_at, then id.

-- ===========================================================================
-- Update relay_spending_summary view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_summary
WITH (security_invoker = on)
AS
WITH deduped_batches AS (
    SELECT DISTINCT ON (u.user_id, u.batch_id)
        u.*
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NOT NULL
    ORDER BY u.user_id, u.batch_id, u.logged_at DESC, u.created_at DESC, u.id DESC
),
relay_logs AS (
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NULL
)
SELECT
    p.user_id,
    p.email,
    p.tier,
    COUNT(r.id) AS total_requests,
    COALESCE(SUM(r.input_tokens), 0) AS total_input_tokens,
    COALESCE(SUM(GREATEST(r.input_tokens - COALESCE(r.cached_input_tokens, 0), 0)), 0)
      AS total_net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(r.cached_input_tokens), 0) AS total_cached_tokens,
    COALESCE(SUM(r.reasoning_tokens), 0) AS total_reasoning_tokens,
    COALESCE(SUM(r.cost), 0) AS total_cost_usd,
    MIN(r.logged_at) AS first_request_at,
    MAX(r.logged_at) AS last_request_at
FROM public.profiles p
LEFT JOIN relay_logs r
    ON p.user_id = r.user_id
GROUP BY p.user_id, p.email, p.tier;

COMMENT ON VIEW public.relay_spending_summary IS
'Per-user relay spending totals (ADMIN ONLY - access via service role)';

-- ===========================================================================
-- Update relay_spending_by_model view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_by_model
WITH (security_invoker = on)
AS
WITH deduped_batches AS (
    SELECT DISTINCT ON (u.user_id, u.batch_id)
        u.*
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NOT NULL
    ORDER BY u.user_id, u.batch_id, u.logged_at DESC, u.created_at DESC, u.id DESC
),
relay_logs AS (
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NULL
)
SELECT
    p.user_id,
    p.email,
    p.tier,
    r.model,
    r.provider,
    COUNT(r.id) AS request_count,
    COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(GREATEST(r.input_tokens - COALESCE(r.cached_input_tokens, 0), 0)), 0)
      AS net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(r.cost), 0) AS cost_usd,
    AVG(r.response_time_ms) AS avg_response_time_ms
FROM public.profiles p
INNER JOIN relay_logs r
    ON p.user_id = r.user_id
GROUP BY p.user_id, p.email, p.tier, r.model, r.provider;

COMMENT ON VIEW public.relay_spending_by_model IS
'Relay spending by user and model (ADMIN ONLY - access via service role)';

-- ===========================================================================
-- Update relay_spending_daily view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_daily
WITH (security_invoker = on)
AS
WITH deduped_batches AS (
    SELECT DISTINCT ON (u.user_id, u.batch_id)
        u.*
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NOT NULL
    ORDER BY u.user_id, u.batch_id, u.logged_at DESC, u.created_at DESC, u.id DESC
),
relay_logs AS (
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NULL
)
SELECT
    p.user_id,
    p.email,
    DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    COUNT(r.id) AS request_count,
    COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(GREATEST(r.input_tokens - COALESCE(r.cached_input_tokens, 0), 0)), 0)
      AS net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(r.cost), 0) AS cost_usd
FROM public.profiles p
INNER JOIN relay_logs r
    ON p.user_id = r.user_id
GROUP BY p.user_id, p.email, DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_daily IS
'Daily relay spending per user in UTC (ADMIN ONLY - access via service role)';

-- ===========================================================================
-- Update relay_spending_monthly view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_monthly
WITH (security_invoker = on)
AS
WITH deduped_batches AS (
    SELECT DISTINCT ON (u.user_id, u.batch_id)
        u.*
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NOT NULL
    ORDER BY u.user_id, u.batch_id, u.logged_at DESC, u.created_at DESC, u.id DESC
),
relay_logs AS (
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NULL
)
SELECT
    p.user_id,
    p.email,
    p.tier,
    DATE_TRUNC('month', r.logged_at AT TIME ZONE 'UTC')::DATE AS month,
    COUNT(r.id) AS request_count,
    COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(GREATEST(r.input_tokens - COALESCE(r.cached_input_tokens, 0), 0)), 0)
      AS net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(r.cached_input_tokens), 0) AS cached_tokens,
    COALESCE(SUM(r.reasoning_tokens), 0) AS reasoning_tokens,
    COALESCE(SUM(r.cost), 0) AS cost_usd,
    COUNT(DISTINCT r.model) AS models_used,
    COUNT(DISTINCT r.provider) AS providers_used
FROM public.profiles p
INNER JOIN relay_logs r
    ON p.user_id = r.user_id
GROUP BY p.user_id, p.email, p.tier, DATE_TRUNC('month', r.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.relay_spending_monthly IS
'Monthly relay spending per user in UTC for billing (ADMIN ONLY - access via service role)';

-- ===========================================================================
-- Update relay_spending_totals view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_totals
WITH (security_invoker = on)
AS
WITH deduped_batches AS (
    SELECT DISTINCT ON (u.user_id, u.batch_id)
        u.*
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NOT NULL
    ORDER BY u.user_id, u.batch_id, u.logged_at DESC, u.created_at DESC, u.id DESC
),
relay_logs AS (
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM public.usage_logs u
    WHERE u.used_relay = TRUE
      AND u.batch_id IS NULL
)
SELECT
    DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    COUNT(DISTINCT r.user_id) AS active_users,
    COUNT(r.id) AS total_requests,
    COALESCE(SUM(r.input_tokens), 0) AS total_input_tokens,
    COALESCE(SUM(GREATEST(r.input_tokens - COALESCE(r.cached_input_tokens, 0), 0)), 0)
      AS total_net_input_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(r.cost), 0) AS total_cost_usd,
    COUNT(DISTINCT r.model) AS models_used
FROM relay_logs r
GROUP BY DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE
ORDER BY day DESC;

COMMENT ON VIEW public.relay_spending_totals IS
'Daily global relay spending totals in UTC (ADMIN ONLY - access via service role)';
