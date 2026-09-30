/**
 * Schema definitions for ProfileView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_PROFILE)
 */
import { z } from 'zod';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { ProviderSettingDefSchema } from '@shared/constants/providers';

// ============================================================
// Data schemas
// ============================================================

/**
 * A native configuration toggle surfaced in a provider's expanded settings.
 * Extends ProviderSettingDefSchema (single source of truth) with runtime `value`.
 */
const ProviderSettingSchema = ProviderSettingDefSchema.extend({
  value: z.boolean(),
});
export type ProviderSetting = z.infer<typeof ProviderSettingSchema>;

const ProviderKeyStatusSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  status: z.enum(['set', 'env', 'not-set']),
  keyUrl: z.string(),
  customEndpoint: z.string().prefault(''),
  supportsCustomEndpoint: z.boolean().prefault(false),
  providerSettings: z.array(ProviderSettingSchema).prefault([]),
});
export type ProviderKeyStatus = z.infer<typeof ProviderKeyStatusSchema>;

// ============================================================
// Outbound message schemas (backend → frontend)
// ============================================================

export const UpdateProfileMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE),
  providerKeyStatuses: z.array(ProviderKeyStatusSchema).prefault([]),
});
export type UpdateProfileMessage = z.infer<typeof UpdateProfileMessageSchema>;
