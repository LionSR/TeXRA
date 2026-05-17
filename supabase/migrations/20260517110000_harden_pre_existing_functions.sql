-- Address Supabase advisor warnings on pre-existing functions:
--   0011 function_search_path_mutable
--   0028 anon_security_definer_function_executable
--   0029 authenticated_security_definer_function_executable
--
-- Pin search_path on all four flagged functions so a malicious schema
-- on the calling role's search_path cannot shadow `public`/`auth`
-- references. For the three SECURITY DEFINER functions, revoke EXECUTE
-- from anon/authenticated so they can't be invoked over /rest/v1/rpc.
-- Service role keeps EXECUTE (used by edge functions and the
-- handle_new_user trigger, which fires regardless of role grants).

-- 1) get_user_by_email — exposes auth.users rows. SECURITY DEFINER.
DO $$
BEGIN
  IF to_regprocedure('public.get_user_by_email(text)') IS NOT NULL THEN
    ALTER FUNCTION public.get_user_by_email(text)
      SET search_path = public, auth, pg_temp;
    REVOKE EXECUTE ON FUNCTION public.get_user_by_email(text)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.get_user_by_email(text) TO service_role;
  END IF;
END $$;

-- 2) get_user_monthly_relay_spend — STABLE, not SECURITY DEFINER, so
-- it inherits the caller's privileges. Only search_path needs pinning;
-- existing grants stay (relay edge fn uses service_role).
DO $$
BEGIN
  IF to_regprocedure(
    'public.get_user_monthly_relay_spend(uuid,timestamp with time zone)'
  ) IS NOT NULL THEN
    ALTER FUNCTION public.get_user_monthly_relay_spend(uuid, timestamptz)
      SET search_path = public, pg_temp;
  END IF;
END $$;

-- 3) handle_new_user — auth.users INSERT trigger. SECURITY DEFINER so
-- it can write into public.profiles. The trigger runs without going
-- through RPC permission checks, so REVOKE here just closes off
-- privilege escalation via /rest/v1/rpc/handle_new_user.
DO $$
BEGIN
  IF to_regprocedure('public.handle_new_user()') IS NOT NULL THEN
    ALTER FUNCTION public.handle_new_user()
      SET search_path = public, pg_temp;
    REVOKE EXECUTE ON FUNCTION public.handle_new_user()
      FROM PUBLIC, anon, authenticated;
  END IF;
END $$;

-- 4) user_has_visibility_access — reads profiles bypassing RLS via
-- SECURITY DEFINER. Currently unreferenced by any RLS policy (the
-- remote_agents policy was inlined in
-- 20260517100300_rls_initplan_wrap_auth_uid.sql) but keep it for any
-- edge-function caller. Service role only.
DO $$
BEGIN
  IF to_regprocedure('public.user_has_visibility_access(text[])') IS NOT NULL THEN
    ALTER FUNCTION public.user_has_visibility_access(text[])
      SET search_path = public, pg_temp;
    REVOKE EXECUTE ON FUNCTION public.user_has_visibility_access(text[])
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.user_has_visibility_access(text[])
      TO service_role;
  END IF;
END $$;
