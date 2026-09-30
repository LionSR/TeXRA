# Anonymous install-id usage logging (runbook)

Internal. Schema and RPCs applied to the live project on 2026-09-30 (steps 1-2
below); function deploy and smoke test (steps 3-4) still pending. Lets TeXRA clients without an account send usage batches to the
`log-usage` edge function, identified by a random install ID instead of a
login. Steps 1-2 are done: do not rerun the migration SQL below (its
`ADD COLUMN`, `ADD CONSTRAINT` and `CREATE INDEX` statements are not
idempotent). Only steps 3-5 remain.

## Contract

- The client sends `X-TeXRA-Install-Id: <lowercase UUIDv4>` and no
  `Authorization` header. The batch body schema is unchanged.
- `log-usage` still accepts a login JWT (released clients). A bearer token that
  fails authentication is a 401; it never falls back to the install header.
- Without a JWT, a well-formed install ID is accepted and rows are written with
  `user_id` NULL and `install_id` set. A missing or malformed credential is a
  401, as before. Exactly one owner per row.
- Code: `supabase/functions/log-usage/usageOwner.ts` (`resolveOwner`) and
  `index.ts`.

## Migration SQL (private migrations repo)

```sql
ALTER TABLE public.usage_logs              ADD COLUMN install_id uuid;
ALTER TABLE public.subscription_usage_logs ADD COLUMN install_id uuid;
ALTER TABLE public.usage_logs              ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.subscription_usage_logs ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.usage_logs ADD CONSTRAINT usage_logs_one_owner
  CHECK ((user_id IS NULL) <> (install_id IS NULL));
ALTER TABLE public.subscription_usage_logs
  ADD CONSTRAINT subscription_usage_logs_one_owner
  CHECK ((user_id IS NULL) <> (install_id IS NULL));

-- Per-stream aggregation for install rows (a NULL user_id never conflicts on
-- the existing (user_id, stream_id) key).
CREATE UNIQUE INDEX usage_logs_install_stream_key
  ON public.usage_logs (install_id, stream_id)
  WHERE install_id IS NOT NULL AND stream_id IS NOT NULL;
CREATE UNIQUE INDEX subscription_usage_logs_install_stream_key
  ON public.subscription_usage_logs (install_id, source, stream_id)
  WHERE install_id IS NOT NULL AND stream_id IS NOT NULL;

-- Batch dedup lookup (the function filters by install_id and batch_id).
CREATE INDEX usage_logs_install_batch_idx
  ON public.usage_logs (install_id, batch_id) WHERE install_id IS NOT NULL;
CREATE INDEX subscription_usage_logs_install_batch_idx
  ON public.subscription_usage_logs (install_id, batch_id)
  WHERE install_id IS NOT NULL;
```

### Upsert RPCs

`usage_logs_upsert(p_rows)` and `subscription_usage_logs_upsert(p_rows)` must
read `install_id` from each row, insert it, and split the conflict target by
owner:

- rows with `user_id`: the existing `ON CONFLICT (user_id, stream_id)` path
  (`(user_id, source, stream_id)` for `subscription_usage_logs_upsert`);
- rows with `install_id`: `ON CONFLICT (install_id, stream_id) WHERE
install_id IS NOT NULL AND stream_id IS NOT NULL` for `usage_logs_upsert`,
  and `ON CONFLICT (install_id, source, stream_id) WHERE install_id IS NOT
NULL AND stream_id IS NOT NULL` for `subscription_usage_logs_upsert`
  (matching its install index), with the same aggregation (`DO UPDATE`)
  expressions as the user path.

**Applied.** The live bodies were rewritten from `pg_get_functiondef` of the
then-current definitions: each keeps its parse/aggregate CTEs and its `DO UPDATE`
expressions, adds `install_id` to the parse, group and insert lists, and runs
two data-modifying CTEs over one materialized `agg` (user rows on the
`(user_id[, source], stream_id)` key, install rows on the
`(install_id[, source], stream_id)` key); the return value is the sum of both
upserts. The subscription table's key includes `source`, so its install index does too. A `p_rows` batch holds one
owner (the function builds it from one request), but rows without a
`stream_id` must keep whatever plain-insert behavior the live bodies have.

RLS is unchanged: both tables are written only by the service role.

## Deploy checklist

1. **Done (2026-09-30).** Write and review the RPC bodies against the live definitions.
2. **Done (2026-09-30).** Apply the migration (columns, constraints, indexes, both RPCs) in one
   transaction. The old function keeps working: it writes `user_id` rows and
   leaves `install_id` NULL.
3. Deploy the function with the same flags as today:
   `supabase functions deploy log-usage --no-verify-jwt`. Confirm the live
   function is already `--no-verify-jwt`; if the gateway verifies JWTs, a
   request with no `Authorization` header is rejected before the function runs.
4. Smoke test with a throwaway UUID (no credentials in the command beyond the
   public function URL):
   `curl -i -X POST "$URL/functions/v1/log-usage" -H 'Content-Type: application/json' -H 'X-TeXRA-Install-Id: 00000000-0000-4000-8000-000000000001' -d '{"batchId":"<uuid>","entries":[{"timestamp":"<iso>","model":"x","provider":"x","inputTokens":1,"outputTokens":1,"cost":0}]}'`
   expects 200 `accepted: 1`; repeat for `deduplicated`; no header expects 401.
   Then delete the test rows (`DELETE ... WHERE install_id = '0000...0001'`).
5. Ship the client only after steps 2-4.

## Rollback

Redeploy the previous function revision (it only writes `user_id`). The schema
change is additive and can stay. To revert it fully, first delete install rows
(`DELETE FROM ... WHERE install_id IS NOT NULL`), then drop the constraints and
indexes, drop `install_id`, restore `user_id SET NOT NULL`, and restore the old
RPC bodies.

## Open risks

- This is an unauthenticated service-role write. No per-install rate limit is
  implemented: the function has no rate-limit store, and a count over the rows
  table cannot bound request rate because `logged_at` is client-supplied and
  aggregated rows do not record arrival. Add a limit at the edge/gateway if
  volume warrants it.
- `UsageBatchSchema` has no upper bound on `entries`; with anonymous callers,
  consider capping it once the client's largest batch is known.
