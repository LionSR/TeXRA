-- Migration: RPC for the log-usage edge function to upsert one row per
-- (user_id, stream_id). Version-aware so we don't break the small
-- residue of pre-0.35.4 clients that still send cumulative totals.
--
-- Apply this before 20260517_usage_logs_aggregate_per_stream.sql, and
-- deploy the matching log-usage edge function (which calls this RPC)
-- before the aggregation migration takes effect.

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
      CASE WHEN r ? 'used_relay' AND r->>'used_relay' <> ''
           THEN (r->>'used_relay')::boolean END AS used_relay,
      NULLIF(r->>'stream_id', '') AS stream_id,
      NULLIF(r->>'extension_version', '') AS extension_version,
      (r->>'batch_id')::uuid AS batch_id,
      NULLIF(r->>'editor_type', '') AS editor_type
    FROM jsonb_array_elements(p_rows) r
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
  FROM parsed
  ON CONFLICT (user_id, stream_id) WHERE stream_id IS NOT NULL DO UPDATE SET
    -- Clients >= 0.35.4 send per-round deltas (SUM); older clients send
    -- cumulative totals so the LAST row wins (GREATEST). response_time_ms
    -- is always cumulative on the wire — MAX regardless of version.
    input_tokens = CASE
      WHEN COALESCE(EXCLUDED.extension_version, '9.9.9') >= '0.35.4'
      THEN public.usage_logs.input_tokens + EXCLUDED.input_tokens
      ELSE GREATEST(public.usage_logs.input_tokens, EXCLUDED.input_tokens) END,
    output_tokens = CASE
      WHEN COALESCE(EXCLUDED.extension_version, '9.9.9') >= '0.35.4'
      THEN public.usage_logs.output_tokens + EXCLUDED.output_tokens
      ELSE GREATEST(public.usage_logs.output_tokens, EXCLUDED.output_tokens) END,
    cost = CASE
      WHEN COALESCE(EXCLUDED.extension_version, '9.9.9') >= '0.35.4'
      THEN public.usage_logs.cost + EXCLUDED.cost
      ELSE GREATEST(public.usage_logs.cost, EXCLUDED.cost) END,
    cached_input_tokens = CASE
      WHEN COALESCE(EXCLUDED.extension_version, '9.9.9') >= '0.35.4'
      THEN COALESCE(public.usage_logs.cached_input_tokens, 0) + COALESCE(EXCLUDED.cached_input_tokens, 0)
      ELSE GREATEST(COALESCE(public.usage_logs.cached_input_tokens, 0), COALESCE(EXCLUDED.cached_input_tokens, 0)) END,
    reasoning_tokens = CASE
      WHEN COALESCE(EXCLUDED.extension_version, '9.9.9') >= '0.35.4'
      THEN COALESCE(public.usage_logs.reasoning_tokens, 0) + COALESCE(EXCLUDED.reasoning_tokens, 0)
      ELSE GREATEST(COALESCE(public.usage_logs.reasoning_tokens, 0), COALESCE(EXCLUDED.reasoning_tokens, 0)) END,
    response_time_ms = GREATEST(
      COALESCE(public.usage_logs.response_time_ms, 0),
      COALESCE(EXCLUDED.response_time_ms, 0)),
    used_relay = COALESCE(public.usage_logs.used_relay, false) OR COALESCE(EXCLUDED.used_relay, false),
    logged_at = GREATEST(public.usage_logs.logged_at, EXCLUDED.logged_at),
    extension_version = COALESCE(EXCLUDED.extension_version, public.usage_logs.extension_version),
    -- Static metadata: keep first-set values, but allow late-arriving
    -- fields (model, agent_name, etc.) to populate if the canonical row
    -- happened to be missing them from a pre-aggregation backfill.
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

REVOKE ALL ON FUNCTION public.usage_logs_upsert(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.usage_logs_upsert(jsonb) TO service_role;
