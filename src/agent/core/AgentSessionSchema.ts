// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { AgentCategory } from './AgentDataclass';

/**
 * Canonical schema for agent session descriptors shared across agent modules.
 * This is the SINGLE SOURCE OF TRUTH - the type is derived from this schema.
 *
 * We use z.object() instead of z.strictObject() to remain backward compatible
 * with legacy session descriptors that may contain removed or renamed fields.
 */
export const AgentSessionDescriptorSchema = z.object({
  agentCategory: z.enum(AgentCategory),
});

/**
 * Shared metadata describing how an agent session should be classified.
 * Derived from AgentSessionDescriptorSchema (single source of truth).
 */
export type AgentSessionDescriptor = z.infer<
  typeof AgentSessionDescriptorSchema
>;
