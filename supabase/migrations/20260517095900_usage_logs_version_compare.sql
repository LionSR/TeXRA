-- Helper: numeric per-component version comparison.
--
-- The historical '>= 0.35.4' check across this stack used lexicographic
-- string comparison, which makes any client on v0.35.10 / 0.35.11 / ...
-- (real releases — see CHANGELOG 2026-02-10 for 0.35.10) compare as
-- LESS THAN '0.35.4' because character '1' < '4' at the patch position.
-- That misclassifies those clients as old/cumulative, so SUM/MAX
-- aggregation branches the wrong way and over- or under-counts cost.
--
-- One helper, used by the upsert RPC and the one-time backfill. Returns
-- false for any version that doesn't match the expected x.y.z prefix so
-- malformed payloads route through the conservative cumulative branch.
CREATE OR REPLACE FUNCTION public.is_relay_delta_client(ver text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  WITH parsed AS (
    SELECT regexp_match(ver, '^([0-9]+)\.([0-9]+)\.([0-9]+)') AS parts
  )
  SELECT parts IS NOT NULL
    AND ARRAY[parts[1]::int, parts[2]::int, parts[3]::int] >= ARRAY[0, 35, 4]
  FROM parsed
$$;

REVOKE ALL ON FUNCTION public.is_relay_delta_client(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_relay_delta_client(text) TO anon, authenticated, service_role;

CREATE OR REPLACE VIEW public.usage_base
WITH (security_invoker = on)
AS
-- New clients (v0.35.4+): per-round deltas, keep all rows
WITH new_version_streams AS (
    SELECT *
    FROM public.usage_logs u
    WHERE u.stream_id IS NOT NULL
      AND public.is_relay_delta_client(u.extension_version)
),
-- Old clients (< v0.35.4, NULL, or malformed): accumulated totals, use MAX per stream
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
      AND NOT public.is_relay_delta_client(u.extension_version)
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
