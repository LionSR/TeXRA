/** W1: the run board in the extension frame, on the folded `withWaitingCall`
 *  fixture: a workflow-script run mid-flight with its `Review` phase open. */

import { html, type TemplateResult } from 'lit';

import { applySurfaceAction, emptySurface } from '@shared/session/surface';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { BOARD_NOW, ROOT, withWaitingCall } from '@test/shared/session/fanOutScenario';

import '@progressView/frontend/components/WorkflowRunBoard';

const view = withWaitingCall();
const stream = view.streams.get(ROOT);
if (stream?.category !== 'workflow') {
  throw new Error('withWaitingCall must fold a workflow root');
}
const surface = applySurfaceAction(emptySurface(view.key), {
  kind: 'select',
  streamId: ROOT,
});

/** The bar above the board: the stream's label and status, the run's stop. */
export function runBoardBar(
  iconButton: (
    name: Parameters<typeof waIcon>[0],
    label: string,
  ) => TemplateResult,
): TemplateResult {
  return html`<div class="h-bar">
    ${iconButton('list-ul', 'Sessions')}
    <div class="h-title">
      <span>${stream.label}</span>${waIcon('chevron-right')}<strong
        >${stream.statusLabel}</strong
      >
    </div>
    <span class="h-spacer"></span>${iconButton('circle-stop', 'Kill run')}${iconButton(
      'ellipsis',
      'More',
    )}
  </div>`;
}

export function runBoard(): TemplateResult {
  return html`<workflow-run-board
    class="h-body"
    .stream=${stream}
    .view=${view}
    .surface=${surface}
    .nowMs=${BOARD_NOW}
  ></workflow-run-board>`;
}
