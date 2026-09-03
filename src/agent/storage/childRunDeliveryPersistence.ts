/**
 * Persistence of the artifacts delivered by a child run. Both writes are
 * load-bearing: the post-drain commit marker attests that the child's report
 * and result reached disk, so a failed write fails the delivery (and with it
 * the artifact flush) instead of letting that marker be written over a
 * missing report. A lost execution lease propagates as itself: the run has
 * been displaced and must stop.
 */
import { createLog } from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  persistChildRunReport,
  persistChildRunResultMeta,
} from './childRunPersistence';
import { ExecutionLeaseLostError } from './executionLease';
import type { ResultMeta } from './resultMeta';

const log = createLog('ChildRunDeliveryPersistence');

export async function persistChildRunDelivery(
  executionId: ExecutionId,
  message: string,
  resultMeta: ResultMeta | undefined,
): Promise<void> {
  // `allSettled`, not `all`: both writes are attempted, and the report's
  // failure outranks the manifest's regardless of which rejected first.
  const [report, manifest] = await Promise.allSettled([
    persistChildRunReport(executionId, message),
    resultMeta
      ? persistChildRunResultMeta(executionId, resultMeta)
      : Promise.resolve(),
  ]);
  for (const [kind, result] of [
    ['report', report],
    ['result manifest', manifest],
  ] as const) {
    if (result.status !== 'rejected') continue;
    const err: unknown = result.reason;
    if (err instanceof ExecutionLeaseLostError) throw err;
    log.warn(`Failed to persist ${kind} for ${executionId}`, { data: err });
    throw new Error(
      `Failed to persist ${kind} for ${executionId}: ${toErrorMessage(err)}`,
      { cause: err },
    );
  }
}
