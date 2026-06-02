-- Migration: stop clients from writing their own authorization fields.
--
-- public.profiles had RLS enabled with a permissive UPDATE policy
--   "Users can update own profile"  USING (auth.uid() = user_id)   -- no WITH CHECK
-- and column UPDATE grants to `authenticated` on tier / access_expires_at /
-- permissions. Net effect (verified by simulating an authenticated PostgREST
-- request): any logged-in user could PATCH their own row to set tier='Ultra'
-- (raising the relay spend cap to $300/mo + unlocking every model), push
-- access_expires_at to the far future (defeating expiry-based revocation), or
-- edit permissions. A banned user could simply un-ban themselves this way.
--
-- The client only ever READS profiles (see SupabaseClient.getUserAuthContext,
-- which selects tier/permissions). Every write goes through the backend
-- (service_role edge functions) or SECURITY DEFINER triggers. So reset the
-- client roles to SELECT-only and remove the self-update vector entirely.

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

-- Reset client-role privileges, then grant back only what the relay/client need.
-- service_role and table owner are unaffected (REVOKE targets these two roles).
REVOKE ALL ON public.profiles FROM anon, authenticated;
GRANT SELECT ON public.profiles TO authenticated;

-- The "Users can view own profile" SELECT policy (auth.uid() = user_id) is
-- intentionally left in place: the relay and client read tier / permissions /
-- access_expires_at / banned_until for the requesting user from here.
