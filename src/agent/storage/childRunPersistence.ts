/** Persistence for child-run terminal artifacts (report, result manifest). */
import type { ExecutionId } from '@shared/schemas';

import { getExecutionStore } from './ExecutionKVStore';
import type { ResultMeta } from './resultMeta';

export type ChildRunReportResult =
  { kind: 'persisted' } | { kind: 'failed'; err: unknown };

async function persistChildRunResult(
  write: () => Promise<void>,
): Promise<ChildRunReportResult> {
  try {
    await write();
    return { kind: 'persisted' };
  } catch (err) {
    return { kind: 'failed', err };
  }
}

export async function persistChildRunReport(
  executionId: ExecutionId,
  message: string,
): Promise<ChildRunReportResult> {
  return persistChildRunResult(() =>
    getExecutionStore(executionId).writeReport(message),
  );
}

export async function persistChildRunResultMeta(
  executionId: ExecutionId,
  resultMeta: ResultMeta,
): Promise<ChildRunReportResult> {
  return persistChildRunResult(() =>
    getExecutionStore(executionId).writeResultMeta(resultMeta),
  );
}
