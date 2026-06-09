-- Drop the dead usage_base / relay_usage_base pass-through views.
--
-- usage_logs is now the single source of truth. The historical usage_base
-- version-aware deduplication view became an identity for current production
-- data after per-stream aggregation moved into usage_logs_upsert and the
-- usage_logs table itself. Linked-database verification on 2026-06-09 found
-- zero streamless usage_logs rows and exact total-cost parity between
-- usage_logs and usage_base, so the old streamless batch-dedup branch is not
-- preserving any live data behavior.
-- Repoint the admin spending views and relay spending function directly at
-- usage_logs, then drop the obsolete pass-through views without CASCADE so any
-- missed dependency fails this migration loudly.

CREATE OR REPLACE FUNCTION public.get_user_monthly_relay_spend(
  p_user_id UUID,
  p_month_start TIMESTAMPTZ
)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(r.cost), 0)
  FROM public.usage_logs r
  WHERE r.used_relay = TRUE
    AND r.user_id = p_user_id
    AND r.logged_at >= p_month_start;
$$ LANGUAGE SQL STABLE
SET search_path = public, pg_temp;

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
LEFT JOIN public.usage_logs r
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
INNER JOIN public.usage_logs r
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
INNER JOIN public.usage_logs r
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
INNER JOIN public.usage_logs r
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
FROM public.usage_logs r
WHERE r.used_relay = TRUE
GROUP BY DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE
ORDER BY day DESC;

COMMENT ON VIEW public.relay_spending_totals IS
'Daily global relay spending totals (ADMIN ONLY)';

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
LEFT JOIN public.usage_logs r
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
INNER JOIN public.usage_logs r
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
INNER JOIN public.usage_logs r
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
INNER JOIN public.usage_logs r
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
FROM public.usage_logs r
WHERE r.used_relay IS NOT TRUE
GROUP BY DATE_TRUNC('day', r.logged_at AT TIME ZONE 'UTC')::DATE
ORDER BY day DESC;

COMMENT ON VIEW public.byok_spending_totals IS
'Daily global BYOK spending totals (ADMIN ONLY)';

DROP VIEW IF EXISTS public.relay_usage_base;
DROP VIEW IF EXISTS public.usage_base;
