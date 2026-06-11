-- Long-lived relay tokens for CI pipelines (texra setup-token).
--
-- A CI token is a server-owned credential distinct from Supabase sessions:
-- it is minted once via the relay-tokens edge function (user JWT required),
-- shown to the user exactly once, and persisted only as a SHA-256 hash with
-- audit metadata. The relay and log-usage functions accept it as a bearer
-- credential (prefix `texra_relay_`) and map it to the owning user; scopes
-- restrict it to relay invocation, never account/profile/admin actions.
-- Rows are service-role only: all access goes through edge functions.

CREATE TABLE IF NOT EXISTS public.relay_ci_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  -- Last characters of the token so users can match it in `list` output.
  token_hint text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{relay}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS relay_ci_tokens_user_idx
  ON public.relay_ci_tokens (user_id, created_at DESC);

ALTER TABLE public.relay_ci_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.relay_ci_tokens FROM PUBLIC, anon, authenticated;
