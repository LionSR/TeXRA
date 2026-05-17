-- Lock down access introduced by 20260517_usage_logs_upsert_rpc.sql.
-- Belt-and-suspenders on top of the REVOKE in the original migration,
-- since Supabase auto-grants EXECUTE to anon/authenticated on public
-- functions and the linter (0028/0029) flags SECURITY DEFINER RPCs that
-- end up exposed via /rest/v1/rpc.
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
