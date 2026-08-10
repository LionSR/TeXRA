/** Persistence for child-run terminal artifacts (report, result manifest, turn attribution). */
import type { ExecutionId } from '@shared/schemas';

import { type ChildTurnState, getExecutionStore } from './ExecutionKVStore';
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

/**
 * Persist turn attribution for the report/result slots (#9531). Unlike the
 * report and manifest, this is attribution metadata: a failure downgrades
 * /report//result turn labeling but never the delivered result itself, so it
 * does not mark the lease undurable.
 */
export async function persistChildRunTurnState(
  executionId: ExecutionId,
  state: ChildTurnState,
): Promise<ChildRunReportResult> {
  try {
    await getExecutionStore(executionId).writeTurnState(state);
    return { kind: 'persisted' };
  } catch (err) {
    return { kind: 'failed', err };
  }
}
