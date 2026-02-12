-- Migration: Add relay capacity statistics function
-- Purpose: Efficiently aggregate infrastructure capacity metrics for the
-- GET /relay/capacity admin endpoint. Returns user counts by tier,
-- active relay users, and monthly spending in a single round-trip.
--
-- Note: Monthly spend uses raw usage_logs (not the deduplication views)
-- for speed. The spending check in the relay proxy uses the full
-- deduplication logic; this function is for approximate capacity planning.

-- ==========================================================================
-- Function: get_relay_capacity_stats
-- ==========================================================================

CREATE OR REPLACE FUNCTION get_relay_capacity_stats(
  p_month_start TIMESTAMPTZ
)
RETURNS JSON AS $$
  WITH tier_counts AS (
    SELECT
      COALESCE(tier, 'free') AS tier,
      COUNT(*) AS user_count
    FROM public.profiles
    GROUP BY COALESCE(tier, 'free')
  ),
  monthly_relay AS (
    SELECT
      COUNT(DISTINCT user_id) AS active_users,
      COALESCE(SUM(cost), 0)::NUMERIC(12,2) AS total_spend,
      COUNT(*) AS total_requests
    FROM public.usage_logs
    WHERE used_relay = TRUE
      AND logged_at >= p_month_start
  )
  SELECT json_build_object(
    'registeredUsers', (SELECT COALESCE(SUM(user_count), 0) FROM tier_counts),
    'usersByTier', COALESCE(
      (SELECT json_object_agg(tier, user_count) FROM tier_counts),
      '{}'::json
    ),
    'activeUsersThisMonth', (SELECT active_users FROM monthly_relay),
    'monthlySpendUsd', (SELECT total_spend FROM monthly_relay),
    'monthlyRequests', (SELECT total_requests FROM monthly_relay)
  );
$$ LANGUAGE SQL STABLE SECURITY DEFINER;

COMMENT ON FUNCTION get_relay_capacity_stats(TIMESTAMPTZ) IS
'Aggregate relay capacity metrics: user counts by tier, active users, monthly spend. Admin only.';

-- Restrict access: only service role can call this function.
-- Regular authenticated users cannot access aggregate platform stats.
REVOKE ALL ON FUNCTION get_relay_capacity_stats(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_relay_capacity_stats(TIMESTAMPTZ) FROM authenticated;
