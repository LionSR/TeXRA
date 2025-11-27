// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { AgentCategory, AgentType } from './AgentDataclass';

/**
 * Canonical schema for agent session descriptors shared across agent modules.
 * This is the SINGLE SOURCE OF TRUTH - the type is derived from this schema.
 */
export const AgentSessionDescriptorSchema = z.strictObject({
  agentType: z.enum(AgentType).optional(),
  agentCategory: z.enum(AgentCategory),
});

/**
 * Shared metadata describing how an agent session should be classified.
 * Derived from AgentSessionDescriptorSchema (single source of truth).
 */
export type AgentSessionDescriptor = z.infer<
  typeof AgentSessionDescriptorSchema
>;
