import { Effect, Layer, SubscriptionRef } from 'effect';

import {
  ToolAvailability,
  type ExternalToolCheckResult,
} from '@tools/toolAvailabilityService';

/**
 * The tool availability every test runtime serves: no dependency probe runs
 * (a real one spawns the CLIs it looks for on every session open), and the
 * tool gate withholds nothing until a suite sets results on `results`.
 */
export const unprobedToolAvailability = Layer.effect(
  ToolAvailability,
  Effect.map(
    SubscriptionRef.make<
      ReadonlyMap<string | undefined, readonly ExternalToolCheckResult[]>
    >(new Map()),
    (results) => ({
      results,
      refresh: () => Effect.succeed([]),
      hold: () => Effect.void,
    }),
  ),
);
