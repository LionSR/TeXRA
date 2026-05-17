-- Performance fix for pre-existing RLS policies on profiles,
-- agent_whitelist, remote_agents, and usage_logs. Wraps auth.uid() in a
-- scalar subquery so Postgres evaluates it once per query instead of
-- once per row (linter 0003 / auth_rls_initplan). Semantics unchanged.
-- See https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select

ALTER POLICY "Users can view own profile" ON public.profiles
  USING ((select auth.uid()) = user_id);

ALTER POLICY "Users can update own profile" ON public.profiles
  USING ((select auth.uid()) = user_id);

ALTER POLICY "Users can view own whitelist entries" ON public.agent_whitelist
  USING ((select auth.uid()) = user_id);

ALTER POLICY "Users can read own usage logs" ON public.usage_logs
  USING ((select auth.uid()) = user_id);

ALTER POLICY "Users can view allowed agents" ON public.remote_agents
  USING (
    ('public' = ANY (visibility))
    OR (visibility && (
      SELECT profiles.permissions FROM public.profiles
      WHERE profiles.user_id = (select auth.uid())
    ))
    OR EXISTS (
      SELECT 1 FROM public.agent_whitelist
      WHERE agent_whitelist.agent_id = remote_agents.id
        AND agent_whitelist.user_id = (select auth.uid())
    )
  );
