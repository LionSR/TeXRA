# Anonymous install-id usage logging (runbook)

Internal. Schema and RPCs applied to the live project on 2026-09-30 (steps 1-2
below); do not rerun the migration SQL (its `ADD COLUMN`, `ADD CONSTRAINT` and
`CREATE INDEX` statements are not idempotent). TeXRA clients without an account
send usage batches identified by a random install ID instead of a login. Two
edge functions serve them.

## Layout

| Function       | Owner                                   | Callers                    |
| -------------- | --------------------------------------- | -------------------------- |
| `log-usage-v2` | `X-TeXRA-Install-Id` (lowercase UUIDv4) | current clients, anonymous |
| `log-usage`    | `Authorization: Bearer` login JWT       | already-released clients   |

- Shared: `supabase/functions/_shared/logUsage.ts` (validation, batch dedup,
  equivalent cost, RPC upsert, response shapes, 1000-entry cap),
  `usageValidation.ts`, `equivalentCost.ts`. Per function: `index.ts` (one
  `serveLogUsage(resolver)` call), `usageOwner.ts` (the resolver), `deno.json`,
  `deno.lock` (same pins; keep both in step, see the releasing skill).
- `log-usage-v2`: a stray `Authorization` header is ignored; a missing or
  malformed install ID is a 401. Rows have `user_id` NULL and `install_id` set.
- `log-usage`: the bearer token must authenticate (else 401) and the install
  header is never read. Rows have `user_id` set.
- The sign-in system is gone, so `log-usage` is a legacy path that shrinks to
  nothing; delete it when the owner retires old releases.

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

## Deploy order

Steps 1-2 (schema and RPCs) are done (2026-09-30) and serve both owners.
Until step 4 the live `log-usage` (the combined version, v36: JWT or install
header) keeps working for every client.

1. **Deploy `log-usage-v2` first**, from a clean checkout:
   `supabase functions deploy log-usage-v2 --no-verify-jwt --use-api --project-ref jntubmcgbhwtcktubelv`.
   `--no-verify-jwt` is required: without it the gateway rejects requests that
   carry no `Authorization` header before the function runs.
2. Smoke test against `/functions/v1/log-usage-v2` with a throwaway UUID (no
   credentials beyond the public function URL):
   `curl -i -X POST "$URL/functions/v1/log-usage-v2" -H 'Content-Type: application/json' -H 'X-TeXRA-Install-Id: 00000000-0000-4000-8000-000000000001' -d '{"batchId":"<uuid>","entries":[{"timestamp":"<iso>","model":"x","provider":"x","inputTokens":1,"outputTokens":1,"cost":0}]}'`
   expects 200 `accepted: 1`; repeat for `deduplicated`; no header and a
   malformed ID each expect 401. Then delete the test rows
   (`DELETE ... WHERE install_id = '0000...0001'`).
3. Ship the client pointing at `log-usage-v2` (`src/telemetry/UsageLogService.ts`).
4. **Only after a released client version uses v2** (the owner decides when),
   redeploy `log-usage` JWT-only from this tree, same flags
   (`supabase functions deploy log-usage --no-verify-jwt --use-api --project-ref jntubmcgbhwtcktubelv`),
   so it serves old releases only. Anonymous clients that still post to
   `log-usage` get 401 from then on.

The pending llm-zoo 2.0 pricing change (#13602) rides along with whichever
deploy happens next.

## Rollback

Redeploy the previous function revision of the affected function. The schema
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
