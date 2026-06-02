-- Migration: mirror GoTrue's native ban into profiles for relay enforcement.
--
-- The standard Supabase ban — Admin API `ban_duration` or the Dashboard
-- "Ban user" action — sets auth.users.banned_until and revokes the user's
-- refresh tokens. But a still-valid access token keeps working until it expires
-- (GoTrue exposes no reliable "is banned" check on getUser, see
-- github.com/supabase/auth/issues/1354). We close that window at the relay by
-- checking a mirrored banned_until on profiles, which the relay already reads
-- once per request. The column is server-managed and, after the profiles
-- lockdown migration, not client-writable — so a banned user cannot clear it.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS banned_until timestamptz;

REVOKE UPDATE (banned_until)
  ON public.profiles
  FROM anon, authenticated;

COMMENT ON COLUMN public.profiles.banned_until IS
  'Mirror of auth.users.banned_until (GoTrue native ban). Relay rejects while in the future. Server-managed via trigger; not client-writable.';

-- Keep profiles.banned_until in sync with the source of truth on auth.users.
CREATE OR REPLACE FUNCTION public.sync_profile_banned_until()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.banned_until IS NOT DISTINCT FROM OLD.banned_until THEN
    RETURN NEW;
  END IF;

  UPDATE public.profiles
  SET banned_until = NEW.banned_until
  WHERE user_id = NEW.id;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_profile_banned_until()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_profile_banned_until ON auth.users;
CREATE TRIGGER trg_sync_profile_banned_until
AFTER INSERT OR UPDATE OF banned_until ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.sync_profile_banned_until();

-- Backfill from the source of truth (covers the atomicmail.io cluster already
-- banned via banned_until = 2099 during the incident response).
UPDATE public.profiles p
SET banned_until = u.banned_until
FROM auth.users u
WHERE u.id = p.user_id
  AND p.banned_until IS DISTINCT FROM u.banned_until;
