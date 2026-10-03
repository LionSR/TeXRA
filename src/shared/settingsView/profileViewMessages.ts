/**
 * Schema definitions for ProfileView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_PROFILE)
 */
import { z } from 'zod';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

// ============================================================
// Data schemas
// ============================================================

/**
 * A native configuration toggle surfaced in a provider's expanded settings:
 * one Models tab control (its rows are catalog rows, `stateSettings.ts`
 * `surfaces.models`) with its runtime `value`.
 */
const ProviderSettingSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  warning: z.string().optional(),
  warningUrl: z.string().optional(),
  warningUrlLabel: z.string().optional(),
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
