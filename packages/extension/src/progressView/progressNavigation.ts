import { buildStreamInfo } from '@controllers/progressView/backend/streamInfoUtils';
import type { StreamTabId } from '@shared/schemas';

import {
  ProgressViewProvider,
  type ProgressStreamRevealResult,
} from './ProgressViewProvider';

export type ProgressNavigationRevealResult =
  ProgressStreamRevealResult | 'unavailable';

export async function revealProgressStream(
  streamId: StreamTabId,
): Promise<ProgressNavigationRevealResult> {
  const provider = ProgressViewProvider.getInstance();
  return provider ? provider.revealStream(streamId) : 'unavailable';
}

export function getProgressStreamLabel(
  streamId: StreamTabId,
): string | undefined {
  const state = ProgressViewProvider.getInstance()?.state;
  if (!state) return undefined;
  return buildStreamInfo(state, streamId, 'all')?.label;
}
