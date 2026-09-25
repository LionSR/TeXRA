/** W1: the run board in the extension frame, on a folded board fixture: a
 *  workflow-script run with its `Review` phase open, in each state the
 *  board must show (mid-flight with a decision and a failure, settled, no
 *  failed calls, held by another process). */

import { html, type TemplateResult } from 'lit';

import type { SessionView } from '@shared/session/sessionView';
import { applySurfaceAction, emptySurface } from '@shared/session/surface';
import {
  ROOT,
  withForeignOwner,
  withNoFailedCalls,
  withSettledRun,
  withWaitingCall,
} from '@test/shared/session/fanOutScenario';

import '@progressView/frontend/components/RunHeader';
import '@progressView/frontend/components/WorkflowRunBoard';

/** The fixture each board scene folds. */
export const RUN_BOARD_FIXTURES: Record<string, () => SessionView> = {
  'run-board': withWaitingCall,
  'run-board-settled': withSettledRun,
  'run-board-no-failed': withNoFailedCalls,
  'run-board-foreign': withForeignOwner,
};

/** The run's own header (its one Stop and menu) over the board, on one
 *  folded view. */
export function runBoardScene(fold: () => SessionView): TemplateResult {
  const view = fold();
  const run = view.runs.get(ROOT);
  if (run?.category !== 'workflow') {
    throw new Error('a board fixture must fold a workflow root');
  }
  const surface = applySurfaceAction(emptySurface(view.key), {
    kind: 'select',
    runId: ROOT,
  });
  return html`<run-header .run=${run} .view=${view}></run-header>
    <workflow-run-board
      class="h-body"
      .run=${run}
      .view=${view}
      .surface=${surface}
    ></workflow-run-board>`;
}
