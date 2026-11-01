/**
 * How a script stage reads in every renderer (the progress view, the terminal
 * popup, `texra run`'s plain output): each call's status word, detail and
 * plain line, and the stage's summary, so one status cannot read two ways.
 */
import {
  formatCostUsd,
  formatResultCount,
  type ScriptCallStatus,
  type ScriptCallView,
  type ScriptStageView,
} from '@texra-ai/harness/transcript';

export const SCRIPT_CALL_STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  interrupted: 'Interrupted',
  finished: 'Finished',
  reused: 'Reused',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  failed: 'Failed',
  'not run': 'Not run',
} as const satisfies Record<ScriptCallStatus, string>;

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
    case 'externalInquiry':
      return 'Wants an answer to an inquiry';
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
  const facts = call.facts.length > 0 ? ` · ${call.facts.join(' · ')}` : '';
  const detail = call.detail ? ` — ${detailText(call.detail)}` : '';
  return `${SCRIPT_CALL_STATUS_LABEL[call.status]}: ${call.label}${facts}${detail}`;
}

/** `3 agents · 1 needs you · $0.840`; a count or cost of zero is left out. */
export function scriptStageSummary(stage: ScriptStageView): string {
  return [
    stage.agents > 0 ? formatResultCount(stage.agents, 'agent') : undefined,
    stage.needsYou > 0 ? `${stage.needsYou} needs you` : undefined,
    stage.costUsd > 0 ? formatCostUsd(stage.costUsd) : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
}
