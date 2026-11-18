/**
 * How a script stage reads in every renderer (the progress view, the terminal
 * popup, `texra run`'s plain output): each call's status word, detail and
 * plain line, and the stage's summary, so one status cannot read two ways.
 */
import {
  type ScriptCallStatus,
  type ScriptCallView,
  type ScriptStageView,
} from '@texra-ai/harness/transcript';
import {
  DETAIL_SEPARATOR,
  formatCostUsd,
  formatResultCount,
  joinFacts,
} from '@texra-ai/harness/schemas';
import type { StatusLook } from '@ui/copy/runStatus';

export const SCRIPT_CALL_STATUS_LABEL = Object.freeze({
  queued: 'Queued',
  running: 'Running',
  interrupted: 'Interrupted',
  finished: 'Finished',
  reused: 'Reused',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  failed: 'Failed',
  'not run': 'Not run',
} as const satisfies Record<ScriptCallStatus, string>);

/** How each call status is painted. A queued call has not started and a
 *  reused one ran nothing this time, so neither shows its tone's glyph. */
export const SCRIPT_CALL_STATUS_LOOK: Readonly<
  Record<ScriptCallStatus, StatusLook>
> = Object.freeze({
  queued: Object.freeze({ tone: 'neutral', glyph: 'circle-dot' }),
  running: Object.freeze({ tone: 'running' }),
  interrupted: Object.freeze({ tone: 'warning' }),
  finished: Object.freeze({ tone: 'success' }),
  reused: Object.freeze({ tone: 'success', glyph: 'clock-rotate-left' }),
  skipped: Object.freeze({ tone: 'neutral' }),
  cancelled: Object.freeze({ tone: 'neutral' }),
  failed: Object.freeze({ tone: 'danger' }),
  'not run': Object.freeze({ tone: 'neutral' }),
});

/** What a row says before its answer, in one line. */
function detailText(detail: NonNullable<ScriptCallView['detail']>): string {
  if (detail.kind === 'error') return detail.text;
  if (detail.kind !== 'request')
    return detail.kind === 'notRun'
      ? 'The task ended before this call started.'
      : 'Stopped with its task. Resume the task to continue.';
  const { payload } = detail;
  switch (payload.kind) {
    case 'bash':
      return `Wants bash: ${payload.data.command}`;
    case 'toolEdit':
      return `Wants edit: ${payload.data.relativePath}`;
    case 'retry':
      return `Wants retry: ${payload.data.operation}`;
    case 'proposal':
      return 'Wants approval for a proposal';
    case 'planApproval':
      return 'Wants approval for a plan';
    case 'plugin':
      return 'Wants an answer';
    case 'userQuestion':
      return 'Wants an answer to a question';
    default:
      return payload satisfies never;
  }
}

/** A row's one line: its `detail`, else its answer. */
export function scriptCallSummary(call: ScriptCallView): string | undefined {
  return call.detail === undefined ? call.summary : detailText(call.detail);
}

/** A call's one line: `Running: drafter · gpt-5 — Wants bash: make`. */
export function scriptCallLine(call: ScriptCallView): string {
  const detail = call.detail
    ? `${DETAIL_SEPARATOR}${detailText(call.detail)}`
    : '';
  return `${SCRIPT_CALL_STATUS_LABEL[call.status]}: ${joinFacts([call.label, ...call.facts])}${detail}`;
}

/** `3 agents · 1 needs you · $0.840`; a count or cost of zero is left out. */
export function scriptStageSummary(stage: ScriptStageView): string {
  return joinFacts([
    stage.agents > 0 && formatResultCount(stage.agents, 'agent'),
    stage.needsYou > 0 && `${stage.needsYou} needs you`,
    stage.costUsd > 0 && formatCostUsd(stage.costUsd),
  ]);
}
