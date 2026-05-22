/**
 * Schema definitions for ProfileView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_PROFILE)
 * Inbound: Frontend → Backend (GET_PROFILE_DATA, SELECT_AGENT, etc.)
 */
import { z } from 'zod';

import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands';
import { ProviderVscodeSettingDefSchema } from '@shared/constants/providers';
import { AgentMetadataBaseSchema } from './agent';
import { commandOnly } from './messageFactories';
import { SpendingStatusSchema } from './spendingStatus';

// ============================================================
// Data schemas
// ============================================================

export const ProfileUserSchema = z.object({
  email: z.string(),
  id: z.string(),
});
export type ProfileUser = z.infer<typeof ProfileUserSchema>;

/**
 * Remote agent data for the profile view.
 * Extends AgentMetadataBaseSchema (name, category, description) with
 * profile-specific fields. Description is required (non-optional) here.
 */
export const RemoteAgentSchema = AgentMetadataBaseSchema.extend({
  description: z.string(), // override optional → required for display
  visibility: z.array(z.string()),
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

/**
 * A VS Code configuration toggle surfaced in a provider's expanded settings.
 * Extends ProviderVscodeSettingDefSchema (single source of truth) with runtime `value`.
 */
export const ProviderVscodeSettingSchema =
  ProviderVscodeSettingDefSchema.extend({
    value: z.boolean(),
  });
export type ProviderVscodeSetting = z.infer<typeof ProviderVscodeSettingSchema>;

/** A VS Code numeric configuration surfaced in a settings section. */
export const NumberVscodeSettingSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  value: z.number(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().optional(),
});
export type NumberVscodeSetting = z.infer<typeof NumberVscodeSettingSchema>;

export const ProviderKeyStatusSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  status: z.enum(['set', 'env', 'not-set']),
  keyUrl: z.string(),
  streaming: z.boolean().prefault(true),
  customEndpoint: z.string().prefault(''),
  supportsCustomEndpoint: z.boolean().prefault(false),
  vscodeSettings: z.array(ProviderVscodeSettingSchema).prefault([]),
});
export type ProviderKeyStatus = z.infer<typeof ProviderKeyStatusSchema>;

// ============================================================
// Outbound message schemas (backend → frontend)
// ============================================================

export const UpdateProfileMessageSchema = z.object({
  command: z.literal(PROFILE_VIEW_COMMANDS.UPDATE_PROFILE),
  authenticated: z.boolean(),
  user: ProfileUserSchema.nullable(),
  tier: z.string(),
  permissions: z.array(z.string()),
  remoteAgents: z.array(RemoteAgentSchema),
  apiAccessMode: ApiAccessModeSchema,
  allowedModels: z.array(z.string()).nullable(),
  tierConstants: TierConstantsSchema,
  accessExpiresAt: z.string().nullish(),
  spendingStatus: SpendingStatusSchema.nullish(),
  quotaAutoSwitched: z.boolean().prefault(false),
  providerKeyStatuses: z.array(ProviderKeyStatusSchema).prefault([]),
  globalStreamingDefault: z.boolean().prefault(true),
});
export type UpdateProfileMessage = z.infer<typeof UpdateProfileMessageSchema>;

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

/** Agent selection message (reusable field schema) */
export const SelectAgentMessageSchema = z.object({
  agentName: z.string().min(1),
});
export type SelectAgentMessage = z.infer<typeof SelectAgentMessageSchema>;

/** API access mode message (reusable field schema) */
export const SetApiAccessModeMessageSchema = z.object({
  mode: ApiAccessModeSchema,
});
export type SetApiAccessModeMessage = z.infer<
  typeof SetApiAccessModeMessageSchema
>;

// Inbound messages with command literals
export const GetProfileDataMessageSchema = commandOnly(
  PROFILE_VIEW_COMMANDS.GET_PROFILE_DATA,
);

export const SelectAgentInboundMessageSchema = SelectAgentMessageSchema.extend({
  command: z.literal(PROFILE_VIEW_COMMANDS.SELECT_AGENT),
});

export const SignInMessageSchema = commandOnly(PROFILE_VIEW_COMMANDS.SIGN_IN);

export const SignOutMessageSchema = commandOnly(PROFILE_VIEW_COMMANDS.SIGN_OUT);

export const SetApiAccessModeInboundMessageSchema =
  SetApiAccessModeMessageSchema.extend({
    command: z.literal(PROFILE_VIEW_COMMANDS.SET_API_ACCESS_MODE),
  });
