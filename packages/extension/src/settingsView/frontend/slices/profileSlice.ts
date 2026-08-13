/** Profile handlers: UPDATE_PROFILE. */

import { z } from 'zod';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';
import {
  SpendingStatusErrorSchema,
  SpendingStatusSchema,
} from '@shared/schemas/spendingStatus';

import {
  apiAccessMode,
  authenticated,
  globalStreamingDefault,
  providerKeyStatuses,
  quotaAutoSwitched,
  sessionProblem,
  spendingStatus,
  spendingStatusError,
  tier,
  userEmail,
} from '../settingsState';

/**
 * Value-equality over an object schema's fields. The two spending-status
 * shapes are flat `z.object` contracts (see `spendingStatus.ts`), so a
 * hand-enumerated per-field `&&` chain is just the schema's key list written
 * twice — iterate `schema.shape` instead so adding a field to the schema
 * automatically joins the comparison.
 */
function equalBySchema<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  a: z.infer<T> | null,
  b: z.infer<T> | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const keys = Object.keys(schema.shape) as (keyof z.infer<T>)[];
  return keys.every((key) => a[key] === b[key]);
}

export const profileHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE]: (data) => {
    authenticated.set(data.authenticated);
    userEmail.set(data.user?.email ?? 'N/A');
    tier.set(data.tier);
    const newSpend = data.spendingStatus ?? null;
    // Skip the signal update when the snapshot is value-equal so the Lit
    // re-render isn't triggered on every UPDATE_PROFILE just because the
    // JSON parse produced a fresh object reference.
    if (!equalBySchema(SpendingStatusSchema, spendingStatus.get(), newSpend)) {
      spendingStatus.set(newSpend);
    }
    // Fields declared with `.prefault()` in UpdateProfileMessageSchema are
    // guaranteed present by the validating dispatcher — no fallback needed.
    sessionProblem.set(data.sessionProblem);
    const newSpendError = data.spendingStatusError ?? null;
    if (
      !equalBySchema(
        SpendingStatusErrorSchema,
        spendingStatusError.get(),
        newSpendError,
      )
    ) {
      spendingStatusError.set(newSpendError);
    }
    quotaAutoSwitched.set(data.quotaAutoSwitched);
    apiAccessMode.set(data.apiAccessMode);
    providerKeyStatuses.set(data.providerKeyStatuses);
    globalStreamingDefault.set(data.globalStreamingDefault);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
