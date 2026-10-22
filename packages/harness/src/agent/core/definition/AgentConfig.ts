import type { AgentConfigSchema } from '@shared/schemas';
import type { z } from 'zod';

export type AgentConfig = z.output<typeof AgentConfigSchema>;

/** Partial agent configuration accepted before launch-time normalization. */
export type AgentConfigPayload = Partial<AgentConfig> &
  Pick<AgentConfig, 'agent' | 'model'>;
