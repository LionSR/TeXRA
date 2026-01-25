/**
 * Profile view message schemas.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - webview commands
import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands';

// =============================================================================
// Data Schemas
// =============================================================================

export const ProfileUserSchema = z.object({
  email: z.string(),
  id: z.string(),
});
export type ProfileUser = z.infer<typeof ProfileUserSchema>;

export const RemoteAgentSchema = z.object({
  name: z.string(),
  description: z.string(),
  visibility: z.array(z.string()),
  category: z.string(),
  supportsMultipleOutput: z.boolean(),
});
export type RemoteAgent = z.infer<typeof RemoteAgentSchema>;

export const ApiAccessModeSchema = z.enum(['included', 'personal']);
export type ApiAccessMode = z.infer<typeof ApiAccessModeSchema>;

export const TierConstantsSchema = z.object({
  ultra: z.string(),
  max: z.string(),
});
export type TierConstants = z.infer<typeof TierConstantsSchema>;

// =============================================================================
// Backend → Frontend Messages
// =============================================================================

export const UpdateProfileMessageSchema = z.object({
  command: z.literal(PROFILE_VIEW_COMMANDS.UPDATE_PROFILE),
  authenticated: z.boolean(),
  user: ProfileUserSchema.nullable(),
  tier: z.string(),
  permissions: z.array(z.string()),
  remoteAgents: z.array(RemoteAgentSchema),
  apiAccessMode: ApiAccessModeSchema,
  enabledProviders: z.array(z.string()),
  allowedModels: z.array(z.string()).nullable(),
  tierConstants: TierConstantsSchema,
  accessExpiresAt: z.string().nullish(),
});
export type UpdateProfileMessage = z.infer<typeof UpdateProfileMessageSchema>;
