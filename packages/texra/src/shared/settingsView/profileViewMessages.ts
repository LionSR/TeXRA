/**
 * Schema definitions for ProfileView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_PROFILE)
 */
import { Effect, Schema } from 'effect';

import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';

// ============================================================
// Data schemas
// ============================================================

/**
 * A native configuration toggle surfaced in a provider's expanded settings:
 * one Models tab control (its rows are catalog rows, `stateSettings.ts`
 * `surfaces.models`) with its runtime `value`.
 */
const ProviderSettingSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  description: Schema.String,
  warning: Schema.optional(Schema.String),
  warningUrl: Schema.optional(Schema.String),
  warningUrlLabel: Schema.optional(Schema.String),
  value: Schema.Boolean,
});
export type ProviderSetting = typeof ProviderSettingSchema.Type;

const ProviderKeyStatusSchema = Schema.Struct({
  provider: Schema.String,
  displayName: Schema.String,
  status: Schema.Literals(['set', 'env', 'not-set']),
  customEndpoint: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed('')),
  ),
  supportsCustomEndpoint: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  providerSettings: Schema.Array(ProviderSettingSchema).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ProviderKeyStatus = typeof ProviderKeyStatusSchema.Type;

// ============================================================
// Outbound message schemas (backend → frontend)
// ============================================================

export const UpdateProfileMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE),
  providerKeyStatuses: Schema.Array(ProviderKeyStatusSchema),
});
export type UpdateProfileMessage = typeof UpdateProfileMessageSchema.Type;
