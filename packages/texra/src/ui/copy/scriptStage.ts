/**
 * How a script stage's calls read in every renderer: the word for each
 * call's status (`ScriptCallView.status`) and a call's one plain line. The
 * progress view, the terminal popup and `texra run`'s plain output print
 * these, so one status cannot read two ways.
 */
import type {
  ScriptCallStatus,
  ScriptCallView,
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

/** A call's one line: `Running: drafter · gpt-5 — Wants bash: make`. */
export function scriptCallLine(call: ScriptCallView): string {
  const facts = call.facts.length > 0 ? ` · ${call.facts.join(' · ')}` : '';
  const detail = call.detail ? ` — ${call.detail.text}` : '';
  return `${SCRIPT_CALL_STATUS_LABEL[call.status]}: ${call.label}${facts}${detail}`;
}
