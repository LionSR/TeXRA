import { AgentConfigFieldsSchema } from '@shared/schemas';
import type { z } from 'zod';

/** Agent configuration schema with output file count validation. */
export const AgentConfigSchema = AgentConfigFieldsSchema;

export type AgentConfig = z.output<typeof AgentConfigSchema>;

/** Partial agent configuration accepted before launch-time normalization. */
export type AgentConfigPayload = Partial<AgentConfig> &
  Pick<AgentConfig, 'agent' | 'model'>;
