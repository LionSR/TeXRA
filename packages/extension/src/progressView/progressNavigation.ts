import { Effect } from 'effect';

import type { RunId } from '@shared/schemas';

import {
  ProgressViewProvider,
  type ProgressRunRevealResult,
  type SurfacePlacementFailed,
} from './ProgressViewProvider';

export function revealProgressRun(
  runId: RunId,
): Effect.Effect<
  ProgressRunRevealResult | 'unavailable',
  SurfacePlacementFailed
> {
  const provider = ProgressViewProvider.getInstance();
  return provider ? provider.revealRun(runId) : Effect.succeed('unavailable');
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
