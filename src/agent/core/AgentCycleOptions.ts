// Third-party imports
import { z } from 'zod';

// Local imports - agent configuration
import type { BaseFlowContextInit } from '@agent/implementations/flows/common/BaseFlowServices';

/**
 * User variable channels for template rendering.
 *
 * Two-channel design:
 * - input: Frozen base variables (readonly, set at initialization)
 * - transient: Runtime modifications (mutable copy of base)
 *
 * Note: The former 'output' channel was removed as it was never populated.
 */
export const UserVariableChannelsSchema = z.object({
  input: z.record(z.string(), z.unknown()).readonly(),
  transient: z.record(z.string(), z.unknown()),
});

/** Derived from UserVariableChannelsSchema - single source of truth */
export type UserVariableChannels = z.infer<typeof UserVariableChannelsSchema>;

/**
 * Base options for cycle flows.
 *
 * Uses Pick from BaseFlowContextInit to avoid field duplication.
 * Adds cycle-specific field: client (fresh API client for each cycle).
 */
export type AgentCycleBaseOptions<C = unknown> = Pick<
  BaseFlowContextInit<C>,
  | 'modelHandler'
  | 'setting'
  | 'prompt'
  | 'logger'
  | 'executionContext'
  | 'userVarChannels'
  | 'checkInterruption'
  | 'setAbortController'
> & {
  /** Fresh API client for this cycle */
  client: C;
};
