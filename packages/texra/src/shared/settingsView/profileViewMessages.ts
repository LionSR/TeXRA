/**
 * Schema definitions for ProfileView messages.
 *
 * Outbound: Backend → Frontend (the `profile` page of the host state)
 */
import { Schema } from 'effect';
import { decodingDefault } from '@texra-ai/harness/schemas';
import { CredentialOriginSchema } from '@texra-ai/llm';

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
  status: CredentialOriginSchema,
  customEndpoint: decodingDefault(Schema.String, ''),
  supportsCustomEndpoint: decodingDefault(Schema.Boolean, false),
  providerSettings: decodingDefault(Schema.Array(ProviderSettingSchema), []),
});
export type ProviderKeyStatus = typeof ProviderKeyStatusSchema.Type;

// ============================================================
// Outbound message schemas (backend → frontend)
// ============================================================

/** The provider keys the profile lists. */
export const ProfilePageSchema = Schema.Struct({
  providerKeyStatuses: Schema.Array(ProviderKeyStatusSchema),
});
