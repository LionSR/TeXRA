/**
 * The `ToolAvailability` process service: each workspace's last dependency
 * probe results, and the refresh that re-probes them.
 *
 * The tag lives apart from the probes (`toolAvailabilityLayer` in
 * `./toolAvailability`) because building those reaches the whole plugin
 * manifest: a module that only has to name the service, such as the tool
 * resolver, a composition root's type or a test harness's stand-in, loads
 * none of that graph.
 */
import { Context, type Effect, type Scope, type SubscriptionRef } from 'effect';

import type { ToolProbeInputs } from './toolProbes';

/** Result of running a single external tool check. */
export interface ExternalToolCheckResult {
  readonly id: string;
  readonly tools: readonly string[];
  readonly name: string;
  readonly status: 'available' | 'not-found' | 'unknown';
  /** Short status label for the dashboard badge, when the default is too generic. */
  readonly statusLabel?: string;
  /** Human-readable status detail from the group's `detailCheck`, if any. */
  readonly statusDetail?: string;
}

/** Each workspace root's last results (`undefined` = no folder open); a root
 *  no probe has answered for yet is absent. */
export type AvailabilityResults = ReadonlyMap<
  string | undefined,
  readonly ExternalToolCheckResult[]
>;

export class ToolAvailability extends Context.Service<
  ToolAvailability,
  {
    /** Each workspace root's last results; a dashboard follows its changes. */
    readonly results: SubscriptionRef.SubscriptionRef<AvailabilityResults>;
    /**
     * Probe every plugin for `inputs`' workspace now and publish the
     * results, joining the probe in flight for that root. Tools recently
     * found missing are looked up again, so one installed since shows up.
     * Each plugin's
     * probe has its own deadline and reports a failure as `unknown`, so this
     * never fails.
     */
    readonly refresh: (
      inputs: ToolProbeInputs,
    ) => Effect.Effect<readonly ExternalToolCheckResult[]>;
    /**
     * Keep `roots`' results for the caller's scope and probe them now,
     * without waiting: a session holds its roots for its life. Only a held
     * root's results are kept, and a root's are dropped when its last holder
     * closes, so the map is bounded by the open sessions.
     */
    readonly hold: (
      roots: ToolProbeInputs,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()('@texra/tools/ToolAvailability') {}
