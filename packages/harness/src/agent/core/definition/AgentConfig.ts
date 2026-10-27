import type { AgentConfigSchema } from '@shared/schemas';

/** The configuration one agent run is launched with, as its `run.config`
 *  row stores it. */
export type AgentConfig = typeof AgentConfigSchema.Type;

/** Partial agent configuration accepted before launch-time normalization. */
export type AgentConfigPayload = Partial<AgentConfig> &
  Pick<AgentConfig, 'agent' | 'model'>;
