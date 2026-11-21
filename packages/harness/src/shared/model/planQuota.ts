/**
 * Why a plan's quota endpoint answered no usage windows: no key to ask
 * with, a key the provider refused, a request that failed, or a body that
 * named no window. Every reader of a plan's quota (a run's `resources` tool,
 * a host's usage meter) reports the reason as it is.
 */
import { Schema } from 'effect';

export const PlanQuotaFailureSchema = Schema.Literals([
  'missing_credentials',
  'invalid_credentials',
  'request_failed',
  'malformed_response',
]);
export type PlanQuotaFailure = typeof PlanQuotaFailureSchema.Type;
