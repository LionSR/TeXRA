/** W1: the run board in the extension frame, on a folded board fixture: a
 *  workflow-script run with its `Review` phase open, in each state the
 *  board must show (mid-flight with a decision and a failure, settled, no
 *  failed calls, held by another process). */

import { html, type TemplateResult } from 'lit';

import type { SessionView } from '@shared/session/sessionView';
import { applySurfaceAction, emptySurface } from '@shared/session/surface';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import {
  BOARD_NOW,
  ROOT,
  withForeignOwner,
  withNoFailedCalls,
  withSettledRun,
  withWaitingCall,
} from '@test/shared/session/fanOutScenario';

import '@progressView/frontend/components/WorkflowRunBoard';

type IconButton = (
  name: Parameters<typeof waIcon>[0],
  label: string,
) => TemplateResult;

/** The fixture each board scene folds. */
export const RUN_BOARD_FIXTURES: Record<string, () => SessionView> = {
  'run-board': withWaitingCall,
  'run-board-settled': withSettledRun,
  'run-board-no-failed': withNoFailedCalls,
  'run-board-foreign': withForeignOwner,
};

/** The bar above the board (the stream's label and status, the run's stop)
 *  and the board itself, on one folded view. */
export function runBoardScene(
  fold: () => SessionView,
  iconButton: IconButton,
): TemplateResult {
  const view = fold();
  const stream = view.streams.get(ROOT);
  if (stream?.category !== 'workflow') {
    throw new Error('a board fixture must fold a workflow root');
  }
  const surface = applySurfaceAction(emptySurface(view.key), {
    kind: 'select',
    streamId: ROOT,
  });
  return html`<div class="h-bar">
      ${iconButton('list-ul', 'Sessions')}
      <div class="h-title">
        <span>${stream.label}</span>${waIcon('chevron-right')}<strong
          >${stream.statusLabel}</strong
        >
      </div>
      <span class="h-spacer"></span
      >${iconButton('circle-stop', 'Kill run')}${iconButton('ellipsis', 'More')}
    </div>
    <workflow-run-board
      class="h-body"
      .stream=${stream}
      .view=${view}
      .surface=${surface}
      .nowMs=${BOARD_NOW}
    ></workflow-run-board>`;
}
