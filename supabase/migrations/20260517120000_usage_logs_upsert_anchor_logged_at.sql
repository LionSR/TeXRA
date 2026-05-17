-- Followup to #4159 (cursor bugbot, Medium severity).
--
-- 1) Pure-function GRANT for is_relay_delta_client. The helper has no
--    table access, so granting EXECUTE to authenticated/anon is safe
--    and is required if any future view with security_invoker=on calls
--    it. The current usage_base view still uses an inline string
--    comparison, but locking the helper to service_role only would
--    block obvious follow-up refactors.
--
-- 2) Anchor logged_at to the FIRST round we saw for a stream rather
--    than GREATEST(latest). The previous behavior advanced the row's
--    timestamp to the most recent round, so a stream that began in
--    period A and continued into period B had its ENTIRE cumulative
--    cost attributed to period B by every view that filters/buckets on
--    logged_at — get_user_monthly_relay_spend (rate limiter),
--    relay_spending_daily/monthly, byok_spending_daily/monthly.
--
--    Anchoring to start time has its own bias (cost shows up in the
--    period the stream began), but it matches a user's mental model
--    ("the run I started this month counts against this month") and
--    keeps the rate limiter monotonically correct rather than
--    spuriously failing midway through a long stream.

GRANT EXECUTE ON FUNCTION public.is_relay_delta_client(text)
  TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.usage_logs_upsert(p_rows JSONB)
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
      (r->>'batch_id')::uuid AS batch_id,
      NULLIF(r->>'editor_type', '') AS editor_type
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS input(r, row_ordinal)
  ),
  agg AS (
    SELECT
      user_id, stream_id,
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
    GROUP BY user_id, stream_id, CASE WHEN stream_id IS NULL THEN row_ordinal END
  )
  INSERT INTO public.usage_logs (
    user_id, logged_at, model, provider, agent_name, agent_category,
    is_multiple_output, input_tokens, output_tokens, cost,
    response_time_ms, cached_input_tokens, reasoning_tokens,
    used_relay, stream_id, extension_version, batch_id, editor_type
  )
  SELECT
    user_id, logged_at, model, provider, agent_name, agent_category,
    is_multiple_output, input_tokens, output_tokens, cost,
    response_time_ms, cached_input_tokens, reasoning_tokens,
    used_relay, stream_id, extension_version, batch_id, editor_type
  FROM agg
  ON CONFLICT (user_id, stream_id) WHERE stream_id IS NOT NULL DO UPDATE SET
    input_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN public.usage_logs.input_tokens + EXCLUDED.input_tokens
      ELSE GREATEST(public.usage_logs.input_tokens, EXCLUDED.input_tokens) END,
    output_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN public.usage_logs.output_tokens + EXCLUDED.output_tokens
      ELSE GREATEST(public.usage_logs.output_tokens, EXCLUDED.output_tokens) END,
    cost = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN public.usage_logs.cost + EXCLUDED.cost
      ELSE GREATEST(public.usage_logs.cost, EXCLUDED.cost) END,
    cached_input_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN COALESCE(public.usage_logs.cached_input_tokens, 0) + COALESCE(EXCLUDED.cached_input_tokens, 0)
      ELSE GREATEST(COALESCE(public.usage_logs.cached_input_tokens, 0), COALESCE(EXCLUDED.cached_input_tokens, 0)) END,
    reasoning_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN COALESCE(public.usage_logs.reasoning_tokens, 0) + COALESCE(EXCLUDED.reasoning_tokens, 0)
      ELSE GREATEST(COALESCE(public.usage_logs.reasoning_tokens, 0), COALESCE(EXCLUDED.reasoning_tokens, 0)) END,
    response_time_ms = GREATEST(
      COALESCE(public.usage_logs.response_time_ms, 0),
      COALESCE(EXCLUDED.response_time_ms, 0)),
    used_relay = COALESCE(public.usage_logs.used_relay, false) OR COALESCE(EXCLUDED.used_relay, false),
    -- Anchor to FIRST round (LEAST) instead of GREATEST so cross-period
    -- streams don't migrate their cost into the wrong day/month bucket.
    logged_at = LEAST(public.usage_logs.logged_at, EXCLUDED.logged_at),
    batch_id = COALESCE(EXCLUDED.batch_id, public.usage_logs.batch_id),
    extension_version = COALESCE(EXCLUDED.extension_version, public.usage_logs.extension_version),
    model = COALESCE(public.usage_logs.model, EXCLUDED.model),
    provider = COALESCE(public.usage_logs.provider, EXCLUDED.provider),
    agent_name = COALESCE(public.usage_logs.agent_name, EXCLUDED.agent_name),
    agent_category = COALESCE(public.usage_logs.agent_category, EXCLUDED.agent_category),
    is_multiple_output = COALESCE(public.usage_logs.is_multiple_output, EXCLUDED.is_multiple_output),
    editor_type = COALESCE(public.usage_logs.editor_type, EXCLUDED.editor_type);

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;
