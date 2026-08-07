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

export function getProgressStreamLabel(
  streamId: StreamTabId,
): string | undefined {
  const state = ProgressViewProvider.getInstance()?.state;
  if (!state) return undefined;
  return buildStreamInfo(state, streamId).label;
}
