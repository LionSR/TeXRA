-- Store ChatGPT-subscription usage outside the paid relay/API-key usage table.
--
-- These rows still matter for analytics and user-visible run accounting, but
-- their zero cost should not enter the relay spending table or any downstream
-- paid-usage view that reads public.usage_logs.

CREATE TABLE IF NOT EXISTS public.chatgpt_subscription_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    logged_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    agent_name TEXT,
    agent_category TEXT,
    is_multiple_output BOOLEAN,

    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER,
    reasoning_tokens INTEGER,

    cost DECIMAL(10, 6) NOT NULL DEFAULT 0,
    response_time_ms INTEGER,

    used_relay BOOLEAN DEFAULT FALSE,
    stream_id TEXT,
    extension_version TEXT,
    batch_id UUID,
    editor_type TEXT,

    CONSTRAINT chatgpt_subscription_usage_logs_positive_tokens
      CHECK (input_tokens >= 0 AND output_tokens >= 0),
    CONSTRAINT chatgpt_subscription_usage_logs_positive_cost
      CHECK (cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_chatgpt_subscription_usage_logs_user_id
  ON public.chatgpt_subscription_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_chatgpt_subscription_usage_logs_logged_at
  ON public.chatgpt_subscription_usage_logs(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatgpt_subscription_usage_logs_user_logged_at
  ON public.chatgpt_subscription_usage_logs(user_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatgpt_subscription_usage_logs_model
  ON public.chatgpt_subscription_usage_logs(model);
CREATE INDEX IF NOT EXISTS idx_chatgpt_subscription_usage_logs_provider
  ON public.chatgpt_subscription_usage_logs(provider);
CREATE INDEX IF NOT EXISTS idx_chatgpt_subscription_usage_logs_batch_id
  ON public.chatgpt_subscription_usage_logs(batch_id);
CREATE INDEX IF NOT EXISTS idx_chatgpt_subscription_usage_logs_user_batch
  ON public.chatgpt_subscription_usage_logs(user_id, batch_id);
CREATE UNIQUE INDEX IF NOT EXISTS chatgpt_subscription_usage_logs_user_stream_unique
  ON public.chatgpt_subscription_usage_logs(user_id, stream_id)
  WHERE stream_id IS NOT NULL;

ALTER TABLE public.chatgpt_subscription_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own ChatGPT subscription usage logs"
ON public.chatgpt_subscription_usage_logs FOR SELECT
TO authenticated
USING ((select auth.uid()) = user_id);

GRANT SELECT ON public.chatgpt_subscription_usage_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chatgpt_subscription_usage_logs TO service_role;

CREATE OR REPLACE FUNCTION public.chatgpt_subscription_usage_logs_upsert(p_rows JSONB)
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
      NULLIF(r->>'batch_id', '')::uuid AS batch_id,
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
  INSERT INTO public.chatgpt_subscription_usage_logs (
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
      THEN public.chatgpt_subscription_usage_logs.input_tokens + EXCLUDED.input_tokens
      ELSE GREATEST(public.chatgpt_subscription_usage_logs.input_tokens, EXCLUDED.input_tokens) END,
    output_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN public.chatgpt_subscription_usage_logs.output_tokens + EXCLUDED.output_tokens
      ELSE GREATEST(public.chatgpt_subscription_usage_logs.output_tokens, EXCLUDED.output_tokens) END,
    cost = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN public.chatgpt_subscription_usage_logs.cost + EXCLUDED.cost
      ELSE GREATEST(public.chatgpt_subscription_usage_logs.cost, EXCLUDED.cost) END,
    cached_input_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN COALESCE(public.chatgpt_subscription_usage_logs.cached_input_tokens, 0)
        + COALESCE(EXCLUDED.cached_input_tokens, 0)
      ELSE GREATEST(
        COALESCE(public.chatgpt_subscription_usage_logs.cached_input_tokens, 0),
        COALESCE(EXCLUDED.cached_input_tokens, 0)
      ) END,
    reasoning_tokens = CASE
      WHEN public.is_relay_delta_client(EXCLUDED.extension_version)
      THEN COALESCE(public.chatgpt_subscription_usage_logs.reasoning_tokens, 0) + COALESCE(EXCLUDED.reasoning_tokens, 0)
      ELSE GREATEST(
        COALESCE(public.chatgpt_subscription_usage_logs.reasoning_tokens, 0),
        COALESCE(EXCLUDED.reasoning_tokens, 0)
      ) END,
    response_time_ms = GREATEST(
      COALESCE(public.chatgpt_subscription_usage_logs.response_time_ms, 0),
      COALESCE(EXCLUDED.response_time_ms, 0)),
    used_relay =
      COALESCE(public.chatgpt_subscription_usage_logs.used_relay, false)
      OR COALESCE(EXCLUDED.used_relay, false),
    logged_at = LEAST(public.chatgpt_subscription_usage_logs.logged_at, EXCLUDED.logged_at),
    batch_id = COALESCE(EXCLUDED.batch_id, public.chatgpt_subscription_usage_logs.batch_id),
    extension_version = COALESCE(EXCLUDED.extension_version, public.chatgpt_subscription_usage_logs.extension_version),
    model = COALESCE(public.chatgpt_subscription_usage_logs.model, EXCLUDED.model),
    provider = COALESCE(public.chatgpt_subscription_usage_logs.provider, EXCLUDED.provider),
    agent_name = COALESCE(public.chatgpt_subscription_usage_logs.agent_name, EXCLUDED.agent_name),
    agent_category = COALESCE(public.chatgpt_subscription_usage_logs.agent_category, EXCLUDED.agent_category),
    is_multiple_output = COALESCE(
      public.chatgpt_subscription_usage_logs.is_multiple_output,
      EXCLUDED.is_multiple_output
    ),
    editor_type = COALESCE(public.chatgpt_subscription_usage_logs.editor_type, EXCLUDED.editor_type);

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.chatgpt_subscription_usage_logs_upsert(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chatgpt_subscription_usage_logs_upsert(jsonb)
  TO service_role;

COMMENT ON TABLE public.chatgpt_subscription_usage_logs IS
  'ChatGPT-subscription Codex usage logs kept separate from paid relay/API-key usage';
COMMENT ON COLUMN public.chatgpt_subscription_usage_logs.user_id IS
  'User who made the ChatGPT-subscription-backed request';
COMMENT ON COLUMN public.chatgpt_subscription_usage_logs.logged_at IS
  'When the request completed (client time)';
COMMENT ON COLUMN public.chatgpt_subscription_usage_logs.cost IS
  'Computed cost in USD; ChatGPT-subscription rows are expected to be zero-cost';
COMMENT ON COLUMN public.chatgpt_subscription_usage_logs.used_relay IS
  'Whether server-side relay keys were used; normally false for subscription rows';
COMMENT ON COLUMN public.chatgpt_subscription_usage_logs.stream_id IS
  'Session identifier for grouping requests';
COMMENT ON COLUMN public.chatgpt_subscription_usage_logs.batch_id IS
  'Batch ID for deduplication';
