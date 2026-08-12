/** Best-effort persistence of the artifacts delivered by a child run. */
import type { ExecutionId } from '@shared/schemas';

import {
  persistChildRunReport,
  persistChildRunResultMeta,
} from './childRunPersistence';
import { markOwnedExecutionLeaseUndurable } from './executionLease';
import type { ResultMeta } from './resultMeta';

export async function persistChildRunDeliveryBestEffort(
  executionId: ExecutionId,
  message: string,
  resultMeta: ResultMeta | undefined,
  onFailure: (kind: 'report' | 'result manifest', error: unknown) => void,
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
    markOwnedExecutionLeaseUndurable(executionId);
    onFailure(kind, result.err);
  }
}
