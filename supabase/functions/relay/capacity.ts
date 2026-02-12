/**
 * Relay Capacity Estimation
 *
 * Models the relay's theoretical capacity based on infrastructure constraints
 * and current usage patterns. Used by the GET /relay/capacity admin endpoint.
 *
 * Key bottlenecks (in order of impact):
 * 1. Database connections — spending check query holds connections briefly
 * 2. Financial ceiling — sum of all users' spending limits
 * 3. Edge Function concurrency — CPU/memory for proxying requests
 *
 * Infrastructure assumptions are for Supabase Pro with default Micro compute.
 * Update INFRA_SPECS when changing compute tier.
 */

import { TIER_SPENDING_LIMITS, type TierSpendingLimits } from './models.ts';

// =============================================================================
// Infrastructure Specs
// =============================================================================

/**
 * Supabase infrastructure constraints.
 * Update these when changing Supabase compute tier.
 *
 * Current: Pro plan with default compute (Micro instance).
 * - 2 shared ARM CPUs, 1GB RAM (database)
 * - PgBouncer in transaction mode (200 pooled connections)
 * - Edge Functions run on separate Deno Deploy infra
 */
export const INFRA_SPECS = {
  /** Supabase plan name */
  plan: 'pro' as const,
  /** Compute add-on name */
  compute: 'micro' as const,
  /** Database CPU cores */
  cpus: 2,
  /** Database RAM in GB */
  memoryGb: 1,
  /** Max direct PostgreSQL connections */
  maxDirectConnections: 60,
  /** Max PgBouncer pooled connections (transaction mode) */
  maxPooledConnections: 200,
  /** Edge Function wall clock limit (ms) */
  edgeFunctionTimeoutMs: 400_000,
  /** Upstream request timeout configured in relay (ms) */
  upstreamTimeoutMs: 390_000,
};

/**
 * Operational parameters for capacity modeling.
 * Derived from typical academic usage patterns.
 */
const CAPACITY_PARAMS = {
  /** DB connections briefly held per relay request (auth + spending check) */
  dbConnectionsPerRequest: 2,
  /** Fraction of connection pool reserved for non-relay operations */
  dbPoolReservedFraction: 0.3,
  /** Conservative concurrent-to-registered ratio (peak hour) */
  concurrentRatioHigh: 0.15,
  /** Optimistic concurrent-to-registered ratio (normal usage) */
  concurrentRatioLow: 0.05,
};

// =============================================================================
// Types
// =============================================================================

/** Raw stats fetched from the database */
export interface CapacityStats {
  registeredUsers: number;
  usersByTier: Record<string, number>;
  activeUsersThisMonth: number;
  monthlySpendUsd: number;
  monthlyRequests: number;
}

/** Full capacity report combining real-time data with estimates */
export interface CapacityEstimate {
  infrastructure: typeof INFRA_SPECS;
  current: CapacityStats;
  limits: {
    /** Max simultaneous relay users (connection-pool bound) */
    maxConcurrentUsers: number;
    /** Estimated max registered users before hitting concurrency limits */
    maxRegisteredUsers: { low: number; high: number };
    /** Max possible monthly cost if all users hit spending limits (USD) */
    maxMonthlyCostUsd: number;
    /** Total spending capacity across all current users (USD) */
    currentSpendingCapacityUsd: number;
  };
  utilization: {
    /** Registered users as % of estimated max */
    registeredPercent: number;
    /** Monthly spend as % of total spending capacity */
    spendPercent: number;
    /** Active users as % of concurrent capacity */
    activePercent: number;
  };
}

// =============================================================================
// Estimation Functions
// =============================================================================

/**
 * Max concurrent relay users based on database connection pool.
 *
 * Each relay request briefly holds ~2 pooled connections (auth check +
 * spending check via RPC). PgBouncer transaction mode releases connections
 * between statements, so actual concurrency is much higher than connection
 * count would suggest. We use pooled connections as the primary constraint.
 */
function estimateMaxConcurrentUsers(): number {
  const available = Math.floor(
    INFRA_SPECS.maxPooledConnections *
      (1 - CAPACITY_PARAMS.dbPoolReservedFraction),
  );
  return Math.floor(
    available / CAPACITY_PARAMS.dbConnectionsPerRequest,
  );
}

/**
 * Estimate max registered users from concurrent capacity.
 *
 * Academic usage is bursty — researchers work in focused sessions.
 * The concurrent-to-registered ratio ranges from 5% (light) to 15% (heavy).
 */
function estimateMaxRegisteredUsers(
  maxConcurrent: number,
): { low: number; high: number } {
  return {
    low: Math.floor(maxConcurrent / CAPACITY_PARAMS.concurrentRatioHigh),
    high: Math.floor(maxConcurrent / CAPACITY_PARAMS.concurrentRatioLow),
  };
}

/**
 * Total spending capacity — the sum of all registered users' monthly limits.
 * This is the financial ceiling if every user reached their limit.
 */
function calculateSpendingCapacity(
  usersByTier: Record<string, number>,
): number {
  return Object.entries(usersByTier).reduce((total, [tier, count]) => {
    const limit =
      TIER_SPENDING_LIMITS[tier as keyof TierSpendingLimits] ??
      TIER_SPENDING_LIMITS.free;
    return total + limit * count;
  }, 0);
}

/**
 * Round a number to N decimal places.
 */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Build a full capacity estimate from real-time database stats.
 */
export function buildCapacityEstimate(
  stats: CapacityStats,
): CapacityEstimate {
  const maxConcurrent = estimateMaxConcurrentUsers();
  const maxRegistered = estimateMaxRegisteredUsers(maxConcurrent);
  const spendingCapacity = calculateSpendingCapacity(stats.usersByTier);

  const midpointRegistered = (maxRegistered.low + maxRegistered.high) / 2;

  return {
    infrastructure: { ...INFRA_SPECS },
    current: stats,
    limits: {
      maxConcurrentUsers: maxConcurrent,
      maxRegisteredUsers: maxRegistered,
      maxMonthlyCostUsd: spendingCapacity,
      currentSpendingCapacityUsd: spendingCapacity,
    },
    utilization: {
      registeredPercent:
        midpointRegistered > 0
          ? round((stats.registeredUsers / midpointRegistered) * 100, 1)
          : 0,
      spendPercent:
        spendingCapacity > 0
          ? round((stats.monthlySpendUsd / spendingCapacity) * 100, 1)
          : 0,
      activePercent:
        maxConcurrent > 0
          ? round(
              (stats.activeUsersThisMonth / maxConcurrent) * 100,
              1,
            )
          : 0,
    },
  };
}
