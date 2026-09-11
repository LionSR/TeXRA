import type { RunId } from '@shared/schemas';

import {
  ProgressViewProvider,
  type ProgressRunRevealResult,
} from './ProgressViewProvider';

export async function revealProgressRun(
  runId: RunId,
): Promise<ProgressRunRevealResult | 'unavailable'> {
  const provider = ProgressViewProvider.getInstance();
  return provider ? provider.revealRun(runId) : 'unavailable';
}

/**
 * Select a stream this window just launched (the launch's `onRunResolved`
 * callback). The surface's own selection; a fact never carries focus.
 */
export function presentLaunchedProgressRun(runId: RunId): void {
  ProgressViewProvider.getInstance()?.presentLaunchedRun(runId);
}

export function getProgressRunLabel(runId: RunId): string | undefined {
  return ProgressViewProvider.getInstance()?.runLabel(runId);
}
