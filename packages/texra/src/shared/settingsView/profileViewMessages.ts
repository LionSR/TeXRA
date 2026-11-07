/**
 * Schema definitions for ProfileView messages.
 *
 * Outbound: Backend → Frontend (the `profile` page of the host state)
 */
import { Effect, Schema } from 'effect';

// ============================================================
// Data schemas
// ============================================================

/**
 * A native configuration toggle surfaced in a provider's expanded settings:
 * one Models tab control (a catalog row placed on the tab, `settingSurfaces.ts`
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

/** The provider keys the profile lists. */
export const ProfilePageSchema = Schema.Struct({
  providerKeyStatuses: Schema.Array(ProviderKeyStatusSchema),
});
