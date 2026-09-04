import { buildStreamInfo } from '@controllers/session/streamInfoUtils';
import type { StreamTabId } from '@shared/schemas';

import {
  ProgressViewProvider,
  type ProgressStreamRevealResult,
} from './ProgressViewProvider';

export async function revealProgressStream(
  streamId: StreamTabId,
): Promise<ProgressStreamRevealResult | 'unavailable'> {
  const provider = ProgressViewProvider.getInstance();
  return provider ? provider.revealStream(streamId) : 'unavailable';
}

/**
 * Select a stream this window just launched (the launch's `onStreamResolved`
 * callback). The provider's own selection; a fact never carries focus.
 */
export function presentLaunchedProgressStream(streamId: StreamTabId): void {
  ProgressViewProvider.getInstance()?.backend.presentLaunchedStream(streamId);
}

export function getProgressStreamLabel(
  streamId: StreamTabId,
): string | undefined {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) return undefined;
  return buildStreamInfo(
    provider.state,
    streamId,
    provider.backend.presentation.activeStream,
  ).label;
}
