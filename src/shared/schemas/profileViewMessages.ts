/**
 * Schema definitions for ProfileView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_PROFILE)
 * Inbound: Frontend → Backend (SIGN_IN, SIGN_OUT, etc.)
 */
import { z } from 'zod';

import { PROFILE_VIEW_COMMANDS } from '@shared/ipc';
import { ProviderSettingDefSchema } from '@shared/constants/providers';

import { commandOnly } from './messageFactories';

// ============================================================
// Data schemas
// ============================================================

/**
 * Default for the prefaulted UPDATE_PROFILE streaming field, exported so the
 * settings frontend's pre-hydration state can share it instead of restating
 * the literal.
 */
export const DEFAULT_GLOBAL_STREAMING = true;

const ProfileUserSchema = z.object({
  email: z.string(),
});

const SessionProblemSchema = z.enum(['expired', 'unavailable']);
export type SessionProblem = z.infer<typeof SessionProblemSchema>;

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
  /**
   * Why a stored session could not provide a fresh token. Invalid credentials
   * require reconnection; transient failures should instead invite a retry.
   */
  sessionProblem: SessionProblemSchema.nullable().prefault(null),
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
