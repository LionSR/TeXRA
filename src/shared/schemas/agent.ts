// Third-party imports
import { z } from 'zod';

/**
 * Primary discriminator for agent families.
 */
export enum AgentCategory {
  Workflow = 'workflow',
  ToolUse = 'toolUse',
}

export const AgentCategorySchema = z.enum(AgentCategory);
