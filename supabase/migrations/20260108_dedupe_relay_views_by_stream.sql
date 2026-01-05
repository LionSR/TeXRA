-- Migration: Deduplicate relay spending views by stream and batch
-- Purpose: Recover accurate provider pricing when multiple usage_log rows
-- are emitted for a single stream (with different batch_ids). We keep only
-- the highest-cost entry per (user_id, stream_id) and fall back to batch
-- deduplication for streamless records.

-- Drop existing views so column layout changes are accepted before rebuilding
DROP VIEW IF EXISTS public.relay_spending_totals CASCADE;
DROP VIEW IF EXISTS public.relay_spending_monthly CASCADE;
DROP VIEW IF EXISTS public.relay_spending_daily CASCADE;
DROP VIEW IF EXISTS public.relay_spending_by_model CASCADE;
DROP VIEW IF EXISTS public.relay_spending_summary CASCADE;

-- Shared CTE pattern for relay views
--   - deduped_streams: top-cost row per (user_id, stream_id)
--   - remaining_streamless: relay rows without a stream_id
--   - deduped_batches: top-cost row per (user_id, batch_id) among streamless rows
--   - relay_logs: combined deduplicated set plus unbatched streamless rows

-- ===========================================================================
-- Update relay_spending_summary view
-- ===========================================================================
CREATE OR REPLACE VIEW public.relay_spending_summary
WITH (security_invoker = on)
AS
WITH ranked_streams AS (
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
),
deduped_streams AS (
    SELECT
        rs.id,
        rs.user_id,
        rs.logged_at,
        rs.created_at,
        rs.model,
        rs.provider,
        rs.agent_name,
        rs.agent_category,
        rs.is_multiple_output,
        rs.input_tokens,
        rs.output_tokens,
        rs.cached_input_tokens,
        rs.reasoning_tokens,
        rs.cost,
        rs.response_time_ms,
        rs.used_relay,
        rs.stream_id,
        rs.extension_version,
        rs.batch_id
    FROM ranked_streams rs
    WHERE stream_rank = 1
),
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
),
relay_logs AS (
    SELECT * FROM deduped_streams
    UNION ALL
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM remaining_streamless u
    WHERE u.batch_id IS NULL
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
WITH ranked_streams AS (
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
),
deduped_streams AS (
    SELECT
        rs.id,
        rs.user_id,
        rs.logged_at,
        rs.created_at,
        rs.model,
        rs.provider,
        rs.agent_name,
        rs.agent_category,
        rs.is_multiple_output,
        rs.input_tokens,
        rs.output_tokens,
        rs.cached_input_tokens,
        rs.reasoning_tokens,
        rs.cost,
        rs.response_time_ms,
        rs.used_relay,
        rs.stream_id,
        rs.extension_version,
        rs.batch_id
    FROM ranked_streams rs
    WHERE stream_rank = 1
),
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
),
relay_logs AS (
    SELECT * FROM deduped_streams
    UNION ALL
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM remaining_streamless u
    WHERE u.batch_id IS NULL
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
WITH ranked_streams AS (
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
),
deduped_streams AS (
    SELECT
        rs.id,
        rs.user_id,
        rs.logged_at,
        rs.created_at,
        rs.model,
        rs.provider,
        rs.agent_name,
        rs.agent_category,
        rs.is_multiple_output,
        rs.input_tokens,
        rs.output_tokens,
        rs.cached_input_tokens,
        rs.reasoning_tokens,
        rs.cost,
        rs.response_time_ms,
        rs.used_relay,
        rs.stream_id,
        rs.extension_version,
        rs.batch_id
    FROM ranked_streams rs
    WHERE stream_rank = 1
),
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
),
relay_logs AS (
    SELECT * FROM deduped_streams
    UNION ALL
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM remaining_streamless u
    WHERE u.batch_id IS NULL
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
WITH ranked_streams AS (
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
),
deduped_streams AS (
    SELECT
        rs.id,
        rs.user_id,
        rs.logged_at,
        rs.created_at,
        rs.model,
        rs.provider,
        rs.agent_name,
        rs.agent_category,
        rs.is_multiple_output,
        rs.input_tokens,
        rs.output_tokens,
        rs.cached_input_tokens,
        rs.reasoning_tokens,
        rs.cost,
        rs.response_time_ms,
        rs.used_relay,
        rs.stream_id,
        rs.extension_version,
        rs.batch_id
    FROM ranked_streams rs
    WHERE stream_rank = 1
),
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
),
relay_logs AS (
    SELECT * FROM deduped_streams
    UNION ALL
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM remaining_streamless u
    WHERE u.batch_id IS NULL
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
WITH ranked_streams AS (
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
),
deduped_streams AS (
    SELECT
        rs.id,
        rs.user_id,
        rs.logged_at,
        rs.created_at,
        rs.model,
        rs.provider,
        rs.agent_name,
        rs.agent_category,
        rs.is_multiple_output,
        rs.input_tokens,
        rs.output_tokens,
        rs.cached_input_tokens,
        rs.reasoning_tokens,
        rs.cost,
        rs.response_time_ms,
        rs.used_relay,
        rs.stream_id,
        rs.extension_version,
        rs.batch_id
    FROM ranked_streams rs
    WHERE stream_rank = 1
),
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
),
relay_logs AS (
    SELECT * FROM deduped_streams
    UNION ALL
    SELECT * FROM deduped_batches
    UNION ALL
    SELECT *
    FROM remaining_streamless u
    WHERE u.batch_id IS NULL
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
