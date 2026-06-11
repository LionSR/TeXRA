-- Device-code sign-in requests (RFC 8628 style) for headless CLI login.
--
-- The CLI requests a device code, the user approves it from a browser on any
-- device, and the CLI polls until the request is approved. Rows are
-- service-role only: every read/write goes through the auth-device edge
-- function, never directly from clients. The device code itself is stored
-- only as a SHA-256 hash; the user code is short-lived and single-use.

CREATE TABLE IF NOT EXISTS public.device_auth_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE,
  user_code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied')),
  -- Set when the signed-in browser user approves the request.
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  poll_interval_seconds integer NOT NULL DEFAULT 5
    CHECK (poll_interval_seconds > 0),
  last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS device_auth_requests_expires_idx
  ON public.device_auth_requests (expires_at);

ALTER TABLE public.device_auth_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.device_auth_requests FROM PUBLIC, anon, authenticated;
