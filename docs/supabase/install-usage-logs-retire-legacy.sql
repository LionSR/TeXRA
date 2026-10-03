-- LATER step: run ONLY when `log-usage` is redeployed JWT-only (deploy step 4),
-- in one transaction, after a released client version posts to log-usage-v2.
-- It moves the install rows the combined v34-v36 function wrote into the
-- legacy tables over to install_usage_logs, then restores the legacy tables
-- and upserts to their original (account-only) shape. The tail of this file is
-- the original upsert bodies, exactly as they were before the install-id change.
--
-- The moved rows are the legacy per-stream aggregates (one row per run, not
-- per call); entry_index only keeps them unique within their batch.
BEGIN;

INSERT INTO public.install_usage_logs (
  install_id, batch_id, entry_index, logged_at, model, provider, agent_name,
  agent_category, usage_route, input_tokens, output_tokens,
  cached_input_tokens, reasoning_tokens, cost, response_time_ms, stream_id,
  extension_version, editor_type
)
SELECT
  install_id, batch_id,
  row_number() OVER (PARTITION BY install_id, batch_id ORDER BY id) - 1,
  logged_at, model, provider, agent_name, agent_category,
  usage_route, input_tokens, output_tokens, cached_input_tokens,
  reasoning_tokens, cost, response_time_ms, stream_id, extension_version,
  editor_type
FROM (
  SELECT id, install_id, batch_id, logged_at, model, provider, agent_name,
         agent_category, 'api-key' AS usage_route, input_tokens, output_tokens,
         cached_input_tokens, reasoning_tokens, cost, response_time_ms,
         stream_id, extension_version, editor_type
  FROM public.usage_logs WHERE install_id IS NOT NULL
  UNION ALL
  SELECT id, install_id, batch_id, logged_at, model, provider, agent_name,
         agent_category,
         CASE source WHEN 'chatgpt' THEN 'chatgpt-subscription'
                     WHEN 'kimi' THEN 'kimi-code-subscription'
                     WHEN 'glm' THEN 'glm-coding-plan-subscription'
                     WHEN 'grok' THEN 'xai-subscription' END,
         input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
         cost, response_time_ms, stream_id, extension_version, editor_type
  FROM public.subscription_usage_logs WHERE install_id IS NOT NULL
) moved;

DELETE FROM public.usage_logs WHERE install_id IS NOT NULL;
DELETE FROM public.subscription_usage_logs WHERE install_id IS NOT NULL;

ALTER TABLE public.usage_logs DROP CONSTRAINT usage_logs_one_owner;
ALTER TABLE public.subscription_usage_logs
  DROP CONSTRAINT subscription_usage_logs_one_owner;
DROP INDEX public.usage_logs_install_stream_key;
DROP INDEX public.subscription_usage_logs_install_stream_key;
DROP INDEX public.usage_logs_install_batch_idx;
DROP INDEX public.subscription_usage_logs_install_batch_idx;
ALTER TABLE public.usage_logs DROP COLUMN install_id;
ALTER TABLE public.subscription_usage_logs DROP COLUMN install_id;
ALTER TABLE public.usage_logs ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.subscription_usage_logs ALTER COLUMN user_id SET NOT NULL;

-- Original upsert bodies (pre-install-id).
CREATE OR REPLACE FUNCTION public.usage_logs_upsert(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      -- One delta row = one model call. Legacy snapshot clients re-send
      -- cumulative rows (and retry), so their report count is not a call
      -- count: leave NULL rather than store a wrong number.
      CASE WHEN BOOL_OR(public.is_relay_delta_client(extension_version))
           THEN COUNT(*)::int END AS call_count,
      MAX(response_time_ms) AS response_time_ms,
      BOOL_OR(used_relay) AS used_relay,
      MAX(extension_version) AS extension_version,
      MAX(batch_id::text)::uuid AS batch_id,
      MAX(editor_type) AS editor_type
    FROM parsed
    GROUP BY user_id, stream_id
  )
  INSERT INTO public.usage_logs (
    user_id, logged_at, model, provider, agent_name, agent_category,
    is_multiple_output, input_tokens, output_tokens, cost,
    response_time_ms, cached_input_tokens, reasoning_tokens,
    used_relay, stream_id, extension_version, batch_id, editor_type,
    call_count
  )
  SELECT
    user_id, logged_at, model, provider, agent_name, agent_category,
    is_multiple_output, input_tokens, output_tokens, cost,
    response_time_ms, cached_input_tokens, reasoning_tokens,
    used_relay, stream_id, extension_version, batch_id, editor_type,
    call_count
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
    call_count = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN COALESCE(public.usage_logs.call_count, 0) + COALESCE(EXCLUDED.call_count, 0)
      ELSE public.usage_logs.call_count END,
    response_time_ms = GREATEST(
      COALESCE(public.usage_logs.response_time_ms, 0),
      COALESCE(EXCLUDED.response_time_ms, 0)),
    used_relay = COALESCE(public.usage_logs.used_relay, false) OR COALESCE(EXCLUDED.used_relay, false),
    -- Anchor logged_at to the FIRST round we saw for this stream so
    -- downstream time-bucketed views attribute the run to the period it
    -- began in. Previously this was GREATEST(...), which inflated the
    -- latest period and zeroed earlier ones for cross-boundary streams.
    logged_at = LEAST(public.usage_logs.logged_at, EXCLUDED.logged_at),
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
$function$

;

CREATE OR REPLACE FUNCTION public.subscription_usage_logs_upsert(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      CASE WHEN BOOL_OR(public.is_relay_delta_client(extension_version))
           THEN COUNT(*)::int END AS call_count,
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
    used_relay, stream_id, extension_version, batch_id, editor_type,
    call_count
  )
  SELECT
    user_id, source, logged_at, model, provider, agent_name, agent_category,
    is_multiple_output, input_tokens, output_tokens, cost,
    response_time_ms, cached_input_tokens, reasoning_tokens,
    used_relay, stream_id, extension_version, batch_id, editor_type,
    call_count
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
    call_count = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN COALESCE(public.subscription_usage_logs.call_count, 0) + COALESCE(EXCLUDED.call_count, 0)
      ELSE public.subscription_usage_logs.call_count END,
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
$function$

;

COMMIT;
