-- Generalize the ChatGPT-only subscription usage table into a multi-source
-- one. More subscription-backed providers (e.g. GitHub Copilot) are coming;
-- the table was deployed today with zero rows, so it can be reshaped in
-- place rather than requiring a data migration.

ALTER TABLE public.chatgpt_subscription_usage_logs
  RENAME TO subscription_usage_logs;

ALTER TABLE public.subscription_usage_logs
  ADD COLUMN source TEXT NOT NULL;

ALTER INDEX public.idx_chatgpt_subscription_usage_logs_user_id
  RENAME TO idx_subscription_usage_logs_user_id;
ALTER INDEX public.idx_chatgpt_subscription_usage_logs_logged_at
  RENAME TO idx_subscription_usage_logs_logged_at;
ALTER INDEX public.idx_chatgpt_subscription_usage_logs_user_logged_at
  RENAME TO idx_subscription_usage_logs_user_logged_at;
ALTER INDEX public.idx_chatgpt_subscription_usage_logs_model
  RENAME TO idx_subscription_usage_logs_model;
ALTER INDEX public.idx_chatgpt_subscription_usage_logs_provider
  RENAME TO idx_subscription_usage_logs_provider;
ALTER INDEX public.idx_chatgpt_subscription_usage_logs_batch_id
  RENAME TO idx_subscription_usage_logs_batch_id;
ALTER INDEX public.idx_chatgpt_subscription_usage_logs_user_batch
  RENAME TO idx_subscription_usage_logs_user_batch;

CREATE INDEX idx_subscription_usage_logs_source
  ON public.subscription_usage_logs(source);
CREATE INDEX idx_subscription_usage_logs_user_source
  ON public.subscription_usage_logs(user_id, source);

DROP INDEX IF EXISTS public.chatgpt_subscription_usage_logs_user_stream_unique;
CREATE UNIQUE INDEX subscription_usage_logs_user_source_stream_unique
  ON public.subscription_usage_logs(user_id, source, stream_id)
  WHERE stream_id IS NOT NULL;

ALTER POLICY "Users can read own ChatGPT subscription usage logs"
  ON public.subscription_usage_logs
  RENAME TO "Users can read own subscription usage logs";

DROP FUNCTION IF EXISTS public.chatgpt_subscription_usage_logs_upsert(jsonb);

CREATE OR REPLACE FUNCTION public.subscription_usage_logs_upsert(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected INTEGER := 0;
BEGIN
  WITH parsed AS (
    SELECT
      row_ordinal,
      (r->>'user_id')::uuid AS user_id,
      COALESCE(NULLIF(r->>'source', ''), 'chatgpt') AS source,
      (r->>'logged_at')::timestamptz AS logged_at,
      r->>'model' AS model,
      r->>'provider' AS provider,
      NULLIF(r->>'agent_name', '') AS agent_name,
      NULLIF(r->>'agent_category', '') AS agent_category,
      CASE WHEN r ? 'is_multiple_output' AND r->>'is_multiple_output' <> ''
           THEN (r->>'is_multiple_output')::boolean END AS is_multiple_output,
      COALESCE((r->>'input_tokens')::int, 0) AS input_tokens,
      COALESCE((r->>'output_tokens')::int, 0) AS output_tokens,
      COALESCE((r->>'cost')::numeric, 0) AS cost,
      CASE WHEN r ? 'response_time_ms' AND r->>'response_time_ms' <> ''
           THEN (r->>'response_time_ms')::int END AS response_time_ms,
      CASE WHEN r ? 'cached_input_tokens' AND r->>'cached_input_tokens' <> ''
           THEN (r->>'cached_input_tokens')::int END AS cached_input_tokens,
      CASE WHEN r ? 'reasoning_tokens' AND r->>'reasoning_tokens' <> ''
           THEN (r->>'reasoning_tokens')::int END AS reasoning_tokens,
      COALESCE(NULLIF(r->>'used_relay', '')::boolean, false) AS used_relay,
      NULLIF(r->>'stream_id', '') AS stream_id,
      NULLIF(r->>'extension_version', '') AS extension_version,
      NULLIF(r->>'batch_id', '')::uuid AS batch_id,
      NULLIF(r->>'editor_type', '') AS editor_type
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS input(r, row_ordinal)
  ),
  agg AS (
    SELECT
      user_id, source, stream_id,
      MIN(logged_at) AS logged_at,
      MAX(model) AS model,
      MAX(provider) AS provider,
      MAX(agent_name) AS agent_name,
      MAX(agent_category) AS agent_category,
      BOOL_OR(is_multiple_output) AS is_multiple_output,
      CASE WHEN BOOL_OR(public.is_relay_delta_client(extension_version))
           THEN SUM(input_tokens)::int ELSE MAX(input_tokens) END AS input_tokens,
      CASE WHEN BOOL_OR(public.is_relay_delta_client(extension_version))
           THEN SUM(output_tokens)::int ELSE MAX(output_tokens) END AS output_tokens,
      CASE WHEN BOOL_OR(public.is_relay_delta_client(extension_version))
           THEN SUM(cost)::numeric ELSE MAX(cost) END AS cost,
      CASE WHEN BOOL_OR(public.is_relay_delta_client(extension_version))
           THEN SUM(COALESCE(cached_input_tokens, 0))::int
           ELSE MAX(cached_input_tokens) END AS cached_input_tokens,
      CASE WHEN BOOL_OR(public.is_relay_delta_client(extension_version))
           THEN SUM(COALESCE(reasoning_tokens, 0))::int
           ELSE MAX(reasoning_tokens) END AS reasoning_tokens,
      MAX(response_time_ms) AS response_time_ms,
      BOOL_OR(used_relay) AS used_relay,
      MAX(extension_version) AS extension_version,
      MAX(batch_id::text)::uuid AS batch_id,
      MAX(editor_type) AS editor_type
    FROM parsed
    GROUP BY user_id, source, stream_id, CASE WHEN stream_id IS NULL THEN row_ordinal END
  )
  INSERT INTO public.subscription_usage_logs (
    user_id, source, logged_at, model, provider, agent_name, agent_category,
    is_multiple_output, input_tokens, output_tokens, cost,
    response_time_ms, cached_input_tokens, reasoning_tokens,
    used_relay, stream_id, extension_version, batch_id, editor_type
  )
  SELECT
    user_id, source, logged_at, model, provider, agent_name, agent_category,
    is_multiple_output, input_tokens, output_tokens, cost,
    response_time_ms, cached_input_tokens, reasoning_tokens,
    used_relay, stream_id, extension_version, batch_id, editor_type
  FROM agg
  ON CONFLICT (user_id, source, stream_id) WHERE stream_id IS NOT NULL DO UPDATE SET
    input_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN public.subscription_usage_logs.input_tokens + EXCLUDED.input_tokens
      ELSE GREATEST(public.subscription_usage_logs.input_tokens, EXCLUDED.input_tokens) END,
    output_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN public.subscription_usage_logs.output_tokens + EXCLUDED.output_tokens
      ELSE GREATEST(public.subscription_usage_logs.output_tokens, EXCLUDED.output_tokens) END,
    cost = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN public.subscription_usage_logs.cost + EXCLUDED.cost
      ELSE GREATEST(public.subscription_usage_logs.cost, EXCLUDED.cost) END,
    cached_input_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN COALESCE(public.subscription_usage_logs.cached_input_tokens, 0)
        + COALESCE(EXCLUDED.cached_input_tokens, 0)
      ELSE GREATEST(
        COALESCE(public.subscription_usage_logs.cached_input_tokens, 0),
        COALESCE(EXCLUDED.cached_input_tokens, 0)
      ) END,
    reasoning_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN COALESCE(public.subscription_usage_logs.reasoning_tokens, 0) + COALESCE(EXCLUDED.reasoning_tokens, 0)
      ELSE GREATEST(
        COALESCE(public.subscription_usage_logs.reasoning_tokens, 0),
        COALESCE(EXCLUDED.reasoning_tokens, 0)
      ) END,
    response_time_ms = GREATEST(
      COALESCE(public.subscription_usage_logs.response_time_ms, 0),
      COALESCE(EXCLUDED.response_time_ms, 0)),
    used_relay =
      COALESCE(public.subscription_usage_logs.used_relay, false)
      OR COALESCE(EXCLUDED.used_relay, false),
    logged_at = LEAST(public.subscription_usage_logs.logged_at, EXCLUDED.logged_at),
    batch_id = COALESCE(EXCLUDED.batch_id, public.subscription_usage_logs.batch_id),
    extension_version = COALESCE(EXCLUDED.extension_version, public.subscription_usage_logs.extension_version),
    model = COALESCE(public.subscription_usage_logs.model, EXCLUDED.model),
    provider = COALESCE(public.subscription_usage_logs.provider, EXCLUDED.provider),
    agent_name = COALESCE(public.subscription_usage_logs.agent_name, EXCLUDED.agent_name),
    agent_category = COALESCE(public.subscription_usage_logs.agent_category, EXCLUDED.agent_category),
    is_multiple_output = COALESCE(
      public.subscription_usage_logs.is_multiple_output,
      EXCLUDED.is_multiple_output
    ),
    editor_type = COALESCE(public.subscription_usage_logs.editor_type, EXCLUDED.editor_type);

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_usage_logs_upsert(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.subscription_usage_logs_upsert(jsonb)
  TO service_role;

COMMENT ON TABLE public.subscription_usage_logs IS
  'Subscription-backed (ChatGPT, Copilot, ...) usage logs kept separate from paid relay/API-key usage';
COMMENT ON COLUMN public.subscription_usage_logs.source IS
  'Subscription product this usage ran under, e.g. chatgpt, copilot';
COMMENT ON COLUMN public.subscription_usage_logs.user_id IS
  'User who made the subscription-backed request';
COMMENT ON COLUMN public.subscription_usage_logs.logged_at IS
  'When the request completed (client time)';
COMMENT ON COLUMN public.subscription_usage_logs.cost IS
  'Computed cost in USD; subscription rows are expected to be zero-cost';
COMMENT ON COLUMN public.subscription_usage_logs.used_relay IS
  'Whether server-side relay keys were used; normally false for subscription rows';
COMMENT ON COLUMN public.subscription_usage_logs.stream_id IS
  'Session identifier for grouping requests';
COMMENT ON COLUMN public.subscription_usage_logs.batch_id IS
  'Batch ID for deduplication';

-- Admin analytics views over the subscription usage table, generalized by
-- source, mirroring the relay_spending_*/byok_spending_* view family shape
-- (supabase/migrations/20260609212200_drop_usage_base_view.sql).

CREATE OR REPLACE VIEW public.subscription_usage_summary
WITH (security_invoker = on)
AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    COUNT(s.id) AS total_requests,
    COUNT(DISTINCT s.source) AS sources_used,
    COALESCE(SUM(s.input_tokens + COALESCE(s.cached_input_tokens, 0)), 0)
      AS total_input_tokens,
    COALESCE(SUM(s.input_tokens), 0) AS total_net_input_tokens,
    COALESCE(SUM(s.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(s.cached_input_tokens), 0) AS total_cached_tokens,
    COALESCE(SUM(s.reasoning_tokens), 0) AS total_reasoning_tokens,
    COALESCE(SUM(s.cost), 0) AS total_cost_usd,
    MIN(s.logged_at) AS first_request_at,
    MAX(s.logged_at) AS last_request_at
FROM public.profiles p
LEFT JOIN public.subscription_usage_logs s
    ON p.user_id = s.user_id
GROUP BY p.user_id, p.email, p.tier;

COMMENT ON VIEW public.subscription_usage_summary IS
'Per-user subscription-backed usage totals across all sources (ADMIN ONLY)';

CREATE OR REPLACE VIEW public.subscription_usage_by_source
WITH (security_invoker = on)
AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    s.source,
    COUNT(s.id) AS request_count,
    COALESCE(SUM(s.input_tokens + COALESCE(s.cached_input_tokens, 0)), 0)
      AS input_tokens,
    COALESCE(SUM(s.input_tokens), 0) AS net_input_tokens,
    COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(s.cost), 0) AS cost_usd,
    MIN(s.logged_at) AS first_request_at,
    MAX(s.logged_at) AS last_request_at
FROM public.profiles p
INNER JOIN public.subscription_usage_logs s
    ON p.user_id = s.user_id
GROUP BY p.user_id, p.email, p.tier, s.source;

COMMENT ON VIEW public.subscription_usage_by_source IS
'Subscription-backed usage by user and source, e.g. chatgpt/copilot (ADMIN ONLY)';

CREATE OR REPLACE VIEW public.subscription_usage_by_model
WITH (security_invoker = on)
AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    s.source,
    s.model,
    s.provider,
    COUNT(s.id) AS request_count,
    COALESCE(SUM(s.input_tokens + COALESCE(s.cached_input_tokens, 0)), 0)
      AS input_tokens,
    COALESCE(SUM(s.input_tokens), 0) AS net_input_tokens,
    COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(s.cost), 0) AS cost_usd,
    AVG(s.response_time_ms) AS avg_response_time_ms
FROM public.profiles p
INNER JOIN public.subscription_usage_logs s
    ON p.user_id = s.user_id
GROUP BY p.user_id, p.email, p.tier, s.source, s.model, s.provider;

COMMENT ON VIEW public.subscription_usage_by_model IS
'Subscription-backed usage by user, source, and model (ADMIN ONLY)';

CREATE OR REPLACE VIEW public.subscription_usage_daily
WITH (security_invoker = on)
AS
SELECT
    p.user_id,
    p.email,
    s.source,
    DATE_TRUNC('day', s.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    COUNT(s.id) AS request_count,
    COALESCE(SUM(s.input_tokens + COALESCE(s.cached_input_tokens, 0)), 0)
      AS input_tokens,
    COALESCE(SUM(s.input_tokens), 0) AS net_input_tokens,
    COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(s.cost), 0) AS cost_usd
FROM public.profiles p
INNER JOIN public.subscription_usage_logs s
    ON p.user_id = s.user_id
GROUP BY p.user_id, p.email, s.source, DATE_TRUNC('day', s.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.subscription_usage_daily IS
'Daily subscription-backed usage per user and source (ADMIN ONLY)';

CREATE OR REPLACE VIEW public.subscription_usage_monthly
WITH (security_invoker = on)
AS
SELECT
    p.user_id,
    p.email,
    p.tier,
    s.source,
    DATE_TRUNC('month', s.logged_at AT TIME ZONE 'UTC')::DATE AS month,
    COUNT(s.id) AS request_count,
    COALESCE(SUM(s.input_tokens + COALESCE(s.cached_input_tokens, 0)), 0)
      AS input_tokens,
    COALESCE(SUM(s.input_tokens), 0) AS net_input_tokens,
    COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(s.cached_input_tokens), 0) AS cached_tokens,
    COALESCE(SUM(s.reasoning_tokens), 0) AS reasoning_tokens,
    COALESCE(SUM(s.cost), 0) AS cost_usd,
    COUNT(DISTINCT s.model) AS models_used
FROM public.profiles p
INNER JOIN public.subscription_usage_logs s
    ON p.user_id = s.user_id
GROUP BY p.user_id, p.email, p.tier, s.source, DATE_TRUNC('month', s.logged_at AT TIME ZONE 'UTC')::DATE;

COMMENT ON VIEW public.subscription_usage_monthly IS
'Monthly subscription-backed usage per user and source (ADMIN ONLY)';

CREATE OR REPLACE VIEW public.subscription_usage_totals
WITH (security_invoker = on)
AS
SELECT
    DATE_TRUNC('day', s.logged_at AT TIME ZONE 'UTC')::DATE AS day,
    s.source,
    COUNT(DISTINCT s.user_id) AS active_users,
    COUNT(s.id) AS total_requests,
    COALESCE(SUM(s.input_tokens + COALESCE(s.cached_input_tokens, 0)), 0)
      AS total_input_tokens,
    COALESCE(SUM(s.input_tokens), 0) AS total_net_input_tokens,
    COALESCE(SUM(s.output_tokens), 0) AS total_output_tokens,
    COALESCE(SUM(s.cost), 0) AS total_cost_usd,
    COUNT(DISTINCT s.model) AS models_used
FROM public.subscription_usage_logs s
GROUP BY DATE_TRUNC('day', s.logged_at AT TIME ZONE 'UTC')::DATE, s.source
ORDER BY day DESC, source;

COMMENT ON VIEW public.subscription_usage_totals IS
'Daily global subscription-backed usage totals by source (ADMIN ONLY)';
