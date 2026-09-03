/** Persistence for child-run terminal artifacts (report, result manifest). */
import type { ExecutionId } from '@shared/schemas';

import { getExecutionStore } from './ExecutionKVStore';
import type { ResultMeta } from './resultMeta';

export async function persistChildRunReport(
  executionId: ExecutionId,
  message: string,
): Promise<void> {
  await getExecutionStore(executionId).writeReport(message);
}

export async function persistChildRunResultMeta(
  executionId: ExecutionId,
  resultMeta: ResultMeta,
): Promise<void> {
  await getExecutionStore(executionId).writeResultMeta(resultMeta);
}
