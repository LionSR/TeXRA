-- The REVOKE/GRANT for usage_logs_upsert is also baked into the RPC
-- migration (20260517100000) since Supabase auto-grants EXECUTE to
-- anon/authenticated on public functions. We repeat it here as a
-- belt-and-suspenders safety in case the function gets recreated by
-- another tool without the grants block. Idempotent.
REVOKE EXECUTE ON FUNCTION public.usage_logs_upsert(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.usage_logs_upsert(jsonb) TO service_role;

-- The compaction migration leaves usage_logs_backup_20260517 in the
-- public schema as an operator rollback. It still contains real user
-- data, so enable RLS with no policies to ensure only the service role
-- can read it. Drop the table once the new upsert path has been stable
-- for a few days.
ALTER TABLE IF EXISTS public.usage_logs_backup_20260517
  ENABLE ROW LEVEL SECURITY;
