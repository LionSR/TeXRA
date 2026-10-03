# Anonymous install-id usage logging (runbook)

Internal. TeXRA clients without an account send usage batches identified by a
random install ID instead of a login. Two edge functions serve usage logging;
anonymous data goes to its own table.

## Layout

| Function       | Owner                                   | Writes to                                     | Callers                    |
| -------------- | --------------------------------------- | --------------------------------------------- | -------------------------- |
| `log-usage-v2` | `X-TeXRA-Install-Id` (lowercase UUIDv4) | `install_usage_logs` (append-only, one table) | current clients, anonymous |
| `log-usage`    | `Authorization: Bearer` login JWT       | `usage_logs`, `subscription_usage_logs`       | already-released clients   |

- Shared: `supabase/functions/_shared/logUsage.ts` (CORS, method, owner
  resolution, JSON parse, batch validation and the 1000-entry cap, response
  shapes), `usageValidation.ts`, `equivalentCost.ts` (including `storedCost`:
  a subscription round with client cost 0 stores its llm-zoo list-price
  equivalent). Per function: `index.ts` (one `serveLogUsage(resolver, store)`
  call), `usageOwner.ts` (the resolver), the store (`log-usage-v2/installStore.ts`,
  `log-usage/legacyStore.ts`), `deno.json` and `deno.lock` (same pins; keep both
  in step, see the releasing skill).
- `log-usage-v2`: a stray `Authorization` header is ignored; a missing or
  malformed install ID is a 401.
- `log-usage`: the bearer token must authenticate (else 401) and the install
  header is never read.
- The sign-in system is gone, so `log-usage` is a legacy path that shrinks to
  nothing; delete it, and the legacy tables, when the owner retires old
  releases.

## Why a separate append-only table

- The legacy tables have an FK to `auth.users` (ON DELETE CASCADE), a "users
  can read own" RLS policy, and 18 dependent views (`byok_spending_*`,
  `relay_spending_*`, `subscription_usage_*`, `editor_usage_*`) that assume every
  row has a `user_id`. 861 install rows had already leaked into them through
  the combined v34-v36 function. A separate table keeps those views correct,
  gives anonymous data no account link, deletes by `install_id`, and lets the
  legacy tables drop whole later.
- The client sends one entry per model call (`reportUsage` in
  `src/agent/runtime/run/modelCall.ts`, called once per call with that call's
  usage): deltas, never cumulative snapshots. So the table is an event log:
  one row per entry, `UNIQUE (install_id, batch_id, entry_index)` makes a retry
  a no-op (`INSERT ... ON CONFLICT DO NOTHING`), and the function does a plain
  batched insert with the service client. No upsert RPC, no SECURITY DEFINER
  function, no aggregation SQL. Per-stream totals are a `GROUP BY stream_id`
  query.
- Deliberately not carried over from the legacy tables: the upsert RPCs and
  their `GREATEST`/`SUM` snapshot-or-delta split (`is_relay_delta_client`, which
  exists for old snapshot clients), `used_relay`, `is_multiple_output`,
  `call_count` (every row is one call), and the usage_logs /
  subscription_usage_logs split (the route is the `usage_route` column). An
  optional reporting view over `install_usage_logs` is not included.

## SQL

- `docs/supabase/install-usage-logs.sql`: the additive migration (table, unique
  constraint, index, RLS with no policies). Apply first.
- `docs/supabase/install-usage-logs-retire-legacy.sql`: a LATER step, in one
  transaction. It copies the install rows the combined function left in
  `usage_logs` / `subscription_usage_logs` into `install_usage_logs`, deletes
  them from the old tables, drops the `*_one_owner` checks, the `*_install_*`
  indexes and the `install_id` columns, restores `user_id SET NOT NULL`, and
  restores the two original upsert bodies (inlined at the end of the file).
  Run it only together with deploy step 4. Do not run it earlier: the live
  combined function (v36) still writes install rows into the legacy tables and
  depends on those columns.

Neither file has been applied; nothing in this change touches the database or
the live functions.

## Deploy order

Until step 4 the live `log-usage` (the combined version, v36: JWT or install
header) keeps working for every client.

1. Apply `install-usage-logs.sql` (additive).
2. Deploy `log-usage-v2` from a clean checkout:
   `supabase functions deploy log-usage-v2 --no-verify-jwt --use-api --project-ref jntubmcgbhwtcktubelv`.
   `--no-verify-jwt` is required: without it the gateway rejects requests that
   carry no `Authorization` header before the function runs. Then smoke test
   `/functions/v1/log-usage-v2` with a throwaway UUID (no credentials beyond
   the public function URL):
   `curl -i -X POST "$URL/functions/v1/log-usage-v2" -H 'Content-Type: application/json' -H 'X-TeXRA-Install-Id: 00000000-0000-4000-8000-000000000001' -d '{"batchId":"<uuid>","entries":[{"timestamp":"<iso>","model":"x","provider":"x","inputTokens":1,"outputTokens":1,"cost":0}]}'`
   expects 200 `accepted: 1`; repeat for `deduplicated`; no header and a
   malformed ID each expect 401. Then delete the test rows
   (`DELETE FROM public.install_usage_logs WHERE install_id = '00000000-0000-4000-8000-000000000001'`).
3. Ship the client pointing at `log-usage-v2` (`src/telemetry/UsageLogService.ts`).
4. Only after a released client version uses v2 (the owner decides when): run
   `install-usage-logs-retire-legacy.sql`, then redeploy `log-usage` JWT-only
   from this tree with the same flags
   (`supabase functions deploy log-usage --no-verify-jwt --use-api --project-ref jntubmcgbhwtcktubelv`),
   so it serves old releases only. Anonymous clients that still post to
   `log-usage` get 401 from then on.

The pending llm-zoo 2.0 pricing change (#13602) rides along with whichever
deploy happens next.

## Rollback

Redeploy the previous revision of the affected function. The new table is
additive and can stay; drop it only after deleting its rows is acceptable.
After step 4, rolling `log-usage` back to the combined version would need the
install columns and RPC bodies restored first.

## Open risks

- This is an unauthenticated service-role write. No per-install rate limit is
  implemented: the function has no rate-limit store, and `logged_at` is
  client-supplied. Add a limit at the edge/gateway if volume warrants it. A batch
  is capped at 1000 entries (the client's queue size).
- Append-only means rows grow per model call, not per run; add retention if
  volume warrants it.
