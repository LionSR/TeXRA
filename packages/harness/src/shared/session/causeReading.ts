import { Cause, Result } from 'effect';

import { outcomeFromCause, RUN_OUTCOME, type RunId } from '@shared/schemas';

import type { DatabaseWriteFailed } from './database';
import {
  findStorageRefusal,
  runRefusal,
  type RunHistoryRefused,
} from './runHistory';

/**
 * What a failed cause of run `runId`'s work means for the run, asked in one
 * order: an interrupt is the run's stop and wins over anything beside it
 * (`outcomeFromCause`); a write the store refused ends the run whatever
 * failed beside it (as the run's refusal, {@link runRefusal}); then the
 * first typed error; with none, the defect `Cause.squash` picks.
 */
export const readCause = <E>(
  runId: RunId,
  cause: Cause.Cause<E>,
):
  | { readonly kind: 'interrupted' }
  | {
      readonly kind: 'refused';
      readonly refusal: DatabaseWriteFailed | RunHistoryRefused;
    }
  | { readonly kind: 'error'; readonly error: E }
  | { readonly kind: 'defect'; readonly defect: unknown } => {
  if (outcomeFromCause(cause) === RUN_OUTCOME.CANCELLED)
    return { kind: 'interrupted' };
  const refused = findStorageRefusal(cause);
  if (refused) return { kind: 'refused', refusal: runRefusal(runId, refused) };
  const found = Cause.findError(cause);
  return Result.isSuccess(found)
    ? { kind: 'error', error: found.success }
    : { kind: 'defect', defect: Cause.squash(cause) };
};
