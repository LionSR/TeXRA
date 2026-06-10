-- Server-side relay request gates.
--
-- The edge function cannot rely on in-memory counters because Supabase may run
-- multiple isolates. Keep rate windows and active request leases in Postgres.

CREATE TABLE IF NOT EXISTS public.relay_request_limits (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.relay_request_slots (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slot_id uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot_id)
);

CREATE INDEX IF NOT EXISTS relay_request_slots_user_updated_idx
  ON public.relay_request_slots (user_id, updated_at);

ALTER TABLE public.relay_request_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relay_request_slots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.relay_request_limits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.relay_request_slots FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.relay_request_gate(
  p_user_id uuid,
  p_slot_id uuid,
  p_window_start timestamptz,
  p_rate_limit integer,
  p_concurrency_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  gate_row public.relay_request_limits%ROWTYPE;
  now_ts timestamptz := now();
  active_count integer;
  retry_after integer;
BEGIN
  IF p_rate_limit < 1 OR p_concurrency_limit < 1 THEN
    RAISE EXCEPTION 'relay request limits must be positive';
  END IF;

  INSERT INTO public.relay_request_limits (
    user_id,
    window_start,
    request_count,
    updated_at
  )
  VALUES (p_user_id, p_window_start, 0, now_ts)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT *
  INTO gate_row
  FROM public.relay_request_limits
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Avoid permanent lockout if an edge instance dies before streaming release.
  -- Active concurrency is owned by per-request lease rows, not the rate row.
  -- Healthy streams refresh their own lease while the proxy stream is open;
  -- abandoned leases eventually expire when the edge instance cannot release.
  DELETE FROM public.relay_request_slots
  WHERE user_id = p_user_id
    AND updated_at < now_ts - interval '10 minutes';

  SELECT COUNT(*)::integer
  INTO active_count
  FROM public.relay_request_slots
  WHERE user_id = p_user_id;

  IF gate_row.window_start < p_window_start THEN
    gate_row.window_start := p_window_start;
    gate_row.request_count := 0;
  END IF;

  IF active_count >= p_concurrency_limit THEN
    -- Do not refresh timestamps on denials. 429 retries must not keep leaked
    -- slots alive indefinitely.
    UPDATE public.relay_request_limits
    SET window_start = gate_row.window_start,
        request_count = gate_row.request_count
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'concurrency',
      'activeRequests', active_count,
      'concurrencyLimit', p_concurrency_limit,
      'retryAfterSeconds', 5
    );
  END IF;

  IF gate_row.request_count >= p_rate_limit THEN
    retry_after := GREATEST(
      1,
      CEIL(
        EXTRACT(
          EPOCH FROM (gate_row.window_start + interval '1 minute' - now_ts)
        )
      )::integer
    );

    UPDATE public.relay_request_limits
    SET window_start = gate_row.window_start,
        request_count = gate_row.request_count
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'rate',
      'requestsThisMinute', gate_row.request_count,
      'rateLimitPerMinute', p_rate_limit,
      'retryAfterSeconds', retry_after
    );
  END IF;

  INSERT INTO public.relay_request_slots (
    user_id,
    slot_id,
    acquired_at,
    updated_at
  )
  VALUES (p_user_id, p_slot_id, now_ts, now_ts);

  SELECT COUNT(*)::integer
  INTO active_count
  FROM public.relay_request_slots
  WHERE user_id = p_user_id;

  UPDATE public.relay_request_limits
  SET request_count = gate_row.request_count + 1,
      window_start = gate_row.window_start,
      updated_at = now_ts
  WHERE user_id = p_user_id
  RETURNING *
  INTO gate_row;

  RETURN jsonb_build_object(
    'allowed', true,
    'slotId', p_slot_id,
    'activeRequests', active_count,
    'concurrencyLimit', p_concurrency_limit,
    'requestsThisMinute', gate_row.request_count,
    'rateLimitPerMinute', p_rate_limit
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.relay_request_release(
  p_user_id uuid,
  p_slot_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  released boolean;
  active integer;
BEGIN
  DELETE FROM public.relay_request_slots
  WHERE user_id = p_user_id
    AND slot_id = p_slot_id
  RETURNING true
  INTO released;

  SELECT COUNT(*)::integer
  INTO active
  FROM public.relay_request_slots
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'released', COALESCE(released, false),
    'activeRequests', active
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.relay_request_refresh(
  p_user_id uuid,
  p_slot_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  refreshed boolean;
BEGIN
  UPDATE public.relay_request_slots
  SET updated_at = now()
  WHERE user_id = p_user_id
    AND slot_id = p_slot_id
  RETURNING true
  INTO refreshed;

  RETURN jsonb_build_object(
    'refreshed', COALESCE(refreshed, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.relay_request_gate(
  uuid, uuid, timestamptz, integer, integer
)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relay_request_gate(
  uuid, uuid, timestamptz, integer, integer
)
  TO service_role;

REVOKE ALL ON FUNCTION public.relay_request_release(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relay_request_release(uuid, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.relay_request_refresh(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relay_request_refresh(uuid, uuid)
  TO service_role;
