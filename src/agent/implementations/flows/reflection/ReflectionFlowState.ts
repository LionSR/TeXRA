/** Shared state types for reflection flow (flat, natively serializable). */

import { z } from 'zod';

import { ProviderMessageArraySchema } from '@agent/types/ProviderMessage';
import { ReflectionSnapshotStateSchema } from '@shared/schemas';

/**
 * The message-free core (`ReflectionSnapshotStateSchema`, the shape a
 * `flow.snapshot` row carries) plus the round's provider messages, which
 * only the agent layer may name.
 */
export const ReflectionFlowStateSchema = ReflectionSnapshotStateSchema.extend({
  context: ProviderMessageArraySchema.nullable(),
});

/** Shared state type for reflection flow nodes. */
export type ReflectionFlowShared = z.infer<typeof ReflectionFlowStateSchema>;
