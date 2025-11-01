// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { AgentCategory, AgentType } from './AgentDataclass';

/**
 * Canonical schema for agent session descriptors shared across agent modules.
 */
export const AgentSessionDescriptorSchema = z
  .object({
    agentType: z.enum(AgentType).optional(),
    agentCategory: z.enum(AgentCategory),
  })
  .strict();
