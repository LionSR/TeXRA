import { Schema } from 'effect';
import type { AgentConfigSchema } from '@shared/schemas';

export type AgentConfig = typeof AgentConfigSchema.Type;

/** Partial agent configuration accepted before launch-time normalization. */
export type AgentConfigPayload = Partial<AgentConfig> &
  Pick<AgentConfig, 'agent' | 'model'>;
