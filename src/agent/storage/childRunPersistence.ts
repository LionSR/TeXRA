/** Persistence for child-run terminal artifacts (report, result manifest). */
import type { ExecutionId } from '@shared/schemas';

import { getExecutionStore } from './ExecutionKVStore';
import type { ResultMeta } from './resultMeta';

export type ChildRunReportResult =
  { kind: 'persisted' } | { kind: 'failed'; err: unknown };

export async function persistChildRunReport(
  executionId: ExecutionId,
  message: string,
): Promise<ChildRunReportResult> {
  try {
    await getExecutionStore(executionId).writeReport(message);
    return { kind: 'persisted' };
  } catch (err) {
    return { kind: 'failed', err };
  }
}

export async function persistChildRunResultMeta(
  executionId: ExecutionId,
  resultMeta: ResultMeta,
): Promise<ChildRunReportResult> {
  try {
    await getExecutionStore(executionId).writeResultMeta(resultMeta);
    return { kind: 'persisted' };
  } catch (err) {
    return { kind: 'failed', err };
  }
}
