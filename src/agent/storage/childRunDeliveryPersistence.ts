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
  const [report, manifest] = await Promise.all([
    persistChildRunReport(executionId, message),
    resultMeta
      ? persistChildRunResultMeta(executionId, resultMeta)
      : Promise.resolve({ kind: 'persisted' } as const),
  ]);
  for (const [kind, result] of [
    ['report', report],
    ['result manifest', manifest],
  ] as const) {
    if (result.kind !== 'failed') continue;
    if (result.err instanceof ExecutionLeaseLostError) throw result.err;
    log.warn(`Failed to persist ${kind} for ${executionId}`, {
      data: result.err,
    });
    throw new Error(
      `Failed to persist ${kind} for ${executionId}: ${toErrorMessage(result.err)}`,
      { cause: result.err },
    );
  }
}
