-- Migration: aggregate usage_logs into one row per (user_id, stream_id).
-- Purpose: stop usage_logs from growing by round. After this migration each
-- agent run is a single row that the edge function upserts in place via
-- public.usage_logs_upsert. Existing per-round rows are collapsed once.
--
-- Storage win on the snapshot taken on 2026-05-17:
--   411,311 rows -> 6,660 rows  (62x reduction; SUM(cost) preserved exactly
--   against the existing usage_base view at $39,740.62).
--
-- See companion migration 20260517_usage_logs_upsert_rpc.sql for the RPC
-- that the edge function calls; deploy that and the new log-usage edge
-- function before applying this migration so concurrent writes are routed
-- through the upsert path.

BEGIN;

LOCK TABLE public.usage_logs IN EXCLUSIVE MODE;

-- Stream-level classification: any new-version row promotes the stream so
-- that mixed-version streams (rare; only 5 in the production snapshot) are
-- handled as a unit. New-version rows are per-round deltas (SUM); old-
-- version rows carry cumulative totals (take the highest-cost row).
CREATE TEMP TABLE _stream_class ON COMMIT DROP AS
SELECT user_id, stream_id,
  BOOL_OR(public.is_relay_delta_client(extension_version)) AS has_new
FROM public.usage_logs
WHERE stream_id IS NOT NULL
GROUP BY user_id, stream_id;

-- The row we keep per stream — first new-version row (so the collapsed run
-- stays in its starting time bucket), otherwise the highest-cost old-version
-- row. We UPDATE this row in place so the existing primary key id stays stable
-- for any external references.
CREATE TEMP TABLE _compact_keep ON COMMIT DROP AS
WITH joined AS (
  SELECT ul.*, sc.has_new
  FROM public.usage_logs ul
  JOIN _stream_class sc USING (user_id, stream_id)
),
ranked AS (
  SELECT id, user_id, stream_id, has_new,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, stream_id
      ORDER BY
        CASE WHEN has_new AND public.is_relay_delta_client(extension_version) THEN logged_at END ASC NULLS LAST,
        CASE WHEN NOT has_new THEN COALESCE(cost, 0) END DESC NULLS LAST,
        CASE WHEN NOT has_new THEN COALESCE(input_tokens, 0) END DESC NULLS LAST,
        logged_at DESC NULLS LAST,
        created_at DESC,
        id DESC
    ) AS rnk
  FROM joined
)
SELECT id AS keep_id, user_id, stream_id FROM ranked WHERE rnk = 1;

-- Per-stream aggregates. The split mirrors the existing usage_base view:
--   new-version rows: SUM per-round deltas
--   old-version rows: take the highest-cost cumulative row's values
--   response_time_ms is cumulative on the wire regardless of version,
--   so we always take MAX
CREATE TEMP TABLE _compact_agg ON COMMIT DROP AS
WITH new_per_stream AS (
  SELECT user_id, stream_id,
    SUM(input_tokens::bigint) AS in_t,
    SUM(output_tokens::bigint) AS out_t,
    SUM(COALESCE(cached_input_tokens, 0)::bigint) AS cached_t,
    SUM(COALESCE(reasoning_tokens, 0)::bigint) AS reasoning_t,
    MAX(COALESCE(response_time_ms, 0)) AS rt,
    SUM(cost)::numeric AS cost,
    BOOL_OR(COALESCE(used_relay, false)) AS any_relay
  FROM public.usage_logs
  WHERE public.is_relay_delta_client(extension_version)
    AND stream_id IS NOT NULL
  GROUP BY user_id, stream_id
),
old_per_stream AS (
  SELECT DISTINCT ON (user_id, stream_id)
    user_id, stream_id,
    input_tokens, output_tokens,
    COALESCE(cached_input_tokens, 0) AS cached_input_tokens,
    COALESCE(reasoning_tokens, 0) AS reasoning_tokens,
    COALESCE(response_time_ms, 0) AS response_time_ms,
    cost,
    COALESCE(used_relay, false) AS used_relay
  FROM public.usage_logs
  WHERE NOT public.is_relay_delta_client(extension_version)
    AND stream_id IS NOT NULL
  ORDER BY user_id, stream_id,
    COALESCE(cost, 0) DESC, COALESCE(input_tokens, 0) DESC,
    logged_at DESC NULLS LAST, created_at DESC, id DESC
),
all_streams AS (
  SELECT DISTINCT user_id, stream_id FROM public.usage_logs WHERE stream_id IS NOT NULL
)
SELECT s.user_id, s.stream_id,
  (COALESCE(n.in_t, 0) + COALESCE(o.input_tokens, 0))::int AS input_tokens,
  (COALESCE(n.out_t, 0) + COALESCE(o.output_tokens, 0))::int AS output_tokens,
  (COALESCE(n.cached_t, 0) + COALESCE(o.cached_input_tokens, 0))::int AS cached_input_tokens,
  (COALESCE(n.reasoning_t, 0) + COALESCE(o.reasoning_tokens, 0))::int AS reasoning_tokens,
  GREATEST(COALESCE(n.rt, 0), COALESCE(o.response_time_ms, 0)) AS response_time_ms,
  (COALESCE(n.cost, 0) + COALESCE(o.cost, 0))::numeric AS cost,
  (COALESCE(n.any_relay, false) OR COALESCE(o.used_relay, false)) AS used_relay
FROM all_streams s
LEFT JOIN new_per_stream n USING (user_id, stream_id)
LEFT JOIN old_per_stream o USING (user_id, stream_id);

-- Apply aggregates to each kept row.
UPDATE public.usage_logs ul
SET input_tokens = a.input_tokens,
    output_tokens = a.output_tokens,
    cached_input_tokens = a.cached_input_tokens,
    reasoning_tokens = a.reasoning_tokens,
    response_time_ms = a.response_time_ms,
    cost = a.cost,
    used_relay = a.used_relay
FROM _compact_keep k
JOIN _compact_agg a ON a.user_id = k.user_id AND a.stream_id = k.stream_id
WHERE ul.id = k.keep_id;

-- Drop everything else for the same stream.
DELETE FROM public.usage_logs ul
USING (SELECT user_id, stream_id FROM _compact_keep) k
WHERE ul.user_id = k.user_id
  AND ul.stream_id = k.stream_id
  AND ul.id NOT IN (SELECT keep_id FROM _compact_keep);

-- Enforce one row per stream from here on. Partial because streamless
-- rows (no stream_id) should not be unique-constrained.
CREATE UNIQUE INDEX IF NOT EXISTS usage_logs_user_stream_unique
  ON public.usage_logs (user_id, stream_id)
  WHERE stream_id IS NOT NULL;

COMMIT;
