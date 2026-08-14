/**
 * Schema definitions for ProfileView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_PROFILE)
 * Inbound: Frontend → Backend (SIGN_IN, SIGN_OUT, etc.)
 */
import { z } from 'zod';

import { PROFILE_VIEW_COMMANDS } from '@shared/ipc';
import { ProviderSettingDefSchema } from '@shared/constants/providers';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';
import { AgentMetadataBaseSchema } from './agent';
import { commandOnly } from './messageFactories';
import {
  SpendingStatusErrorSchema,
  SpendingStatusSchema,
} from './spendingStatus';

// ============================================================
// Data schemas
// ============================================================

/**
 * Defaults for prefaulted UPDATE_PROFILE fields, exported so the settings
 * frontend's pre-hydration state can share them instead of restating the
 * literals.
 */
export const DEFAULT_QUOTA_AUTO_SWITCHED = false;
export const DEFAULT_GLOBAL_STREAMING = true;

const ProfileUserSchema = z.object({
  email: z.string(),
  id: z.string(),
});

/**
 * Remote agent data for the profile view.
 * Extends AgentMetadataBaseSchema (name, category, description) with
 * profile-specific fields. Description is required (non-optional) here.
 */
const RemoteAgentSchema = AgentMetadataBaseSchema.extend({
  description: z.string(), // override optional → required for display
  supportsMultipleOutput: z.boolean(),
});
export type RemoteAgent = z.infer<typeof RemoteAgentSchema>;

const ApiAccessModeSchema = z.enum(['included', 'personal']);
export type ApiAccessMode = z.infer<typeof ApiAccessModeSchema>;
const SessionProblemSchema = z.enum(['expired', 'unavailable']);
export type SessionProblem = z.infer<typeof SessionProblemSchema>;
export const API_ACCESS_MODE_OPTIONS: readonly {
  readonly value: ApiAccessMode;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: 'included', ...INCLUDED_ACCESS.option },
  { value: 'personal', ...OWN_API_KEYS.option },
] as const;

const TierConstantsSchema = z.object({
  ultra: z.string(),
  max: z.string(),
});

/**
 * A native configuration toggle surfaced in a provider's expanded settings.
 * Extends ProviderSettingDefSchema (single source of truth) with runtime `value`.
 */
const ProviderSettingSchema = ProviderSettingDefSchema.extend({
  value: z.boolean(),
});
export type ProviderSetting = z.infer<typeof ProviderSettingSchema>;

/** A numeric configuration surfaced in a settings section. */
export const NumberSettingSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  value: z.number(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().positive().optional(),
  unit: z.string().optional(),
});
export type NumberSetting = z.infer<typeof NumberSettingSchema>;

const ProviderKeyStatusSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  status: z.enum(['set', 'env', 'not-set']),
  keyUrl: z.string(),
  streaming: z.boolean().prefault(true),
  customEndpoint: z.string().prefault(''),
  supportsCustomEndpoint: z.boolean().prefault(false),
  providerSettings: z.array(ProviderSettingSchema).prefault([]),
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
  remoteAgents: z.array(RemoteAgentSchema),
  apiAccessMode: ApiAccessModeSchema,
  tierConstants: TierConstantsSchema,
  accessExpiresAt: z.string().nullish(),
  /**
   * Why a stored session could not provide a fresh token. Invalid credentials
   * require reconnection; transient failures should instead invite a retry.
   */
  sessionProblem: SessionProblemSchema.nullable().prefault(null),
  spendingStatus: SpendingStatusSchema.nullish(),
  spendingStatusError: SpendingStatusErrorSchema.nullish(),
  quotaAutoSwitched: z.boolean().prefault(DEFAULT_QUOTA_AUTO_SWITCHED),
  providerKeyStatuses: z.array(ProviderKeyStatusSchema).prefault([]),
  globalStreamingDefault: z.boolean().prefault(DEFAULT_GLOBAL_STREAMING),
});
export type UpdateProfileMessage = z.infer<typeof UpdateProfileMessageSchema>;

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

// Inbound messages with command literals
export const SignInMessageSchema = commandOnly(PROFILE_VIEW_COMMANDS.SIGN_IN);

export const SignOutMessageSchema = commandOnly(PROFILE_VIEW_COMMANDS.SIGN_OUT);

export const SetApiAccessModeInboundMessageSchema = z.object({
  command: z.literal(PROFILE_VIEW_COMMANDS.SET_API_ACCESS_MODE),
  mode: ApiAccessModeSchema,
});
