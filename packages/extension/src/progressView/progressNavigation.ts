import type { StreamTabId } from '@shared/schemas';

import {
  ProgressViewProvider,
  type ProgressRunRevealResult,
} from './ProgressViewProvider';

export async function revealProgressRun(
  streamId: StreamTabId,
): Promise<ProgressRunRevealResult | 'unavailable'> {
  const provider = ProgressViewProvider.getInstance();
  return provider ? provider.revealStream(streamId) : 'unavailable';
}

/**
 * Select a stream this window just launched (the launch's `onStreamResolved`
 * callback). The surface's own selection; a fact never carries focus.
 */
export function presentLaunchedProgressRun(streamId: StreamTabId): void {
  ProgressViewProvider.getInstance()?.presentLaunchedStream(streamId);
}

export function getProgressRunLabel(streamId: StreamTabId): string | undefined {
  return ProgressViewProvider.getInstance()?.streamLabel(streamId);
}
