/**
 * Terminal-result → host presentation mapping.
 *
 * The single decision point for the toast a host shows when a run ends in an
 * error. It replaces the per-emission toasts the run lifecycle used to fire:
 * the lifecycle now emits one `result` event, and each host applies this pure
 * mapper in its `session.onResult` consumer, presenting the returned payload
 * through its existing `requestShowInstruction` / `requestShowError` path.
 *
 * Host-neutral: returns the host-agnostic ProgressEvent payloads; it does not
 * touch any UI. Subagent results and non-actionable outcomes (abort, success)
 * return `null` (no toast), preserving the lifecycle's `!isSubagent` gating.
 */
import type { ResultEvent } from '@agent/trace';
import {
  INSTRUCTION_ACTION,
  type ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

export type TerminalResultToast =
  | {
      readonly type: 'instruction';
      readonly payload: ProgressEventPayloads['requestShowInstruction'];
    }
  | {
      readonly type: 'error';
      readonly payload: ProgressEventPayloads['requestShowError'];
    };

const MISSING_API_KEY_MESSAGE =
  'API key not found. Set your API key in the extension settings and run again.';

/**
 * Map a terminal `result` event to the toast a host should present, or `null`
 * when none applies (subagent runs, success, user aborts, unclassified errors).
 */
export function terminalResultToast(
  event: ResultEvent,
): TerminalResultToast | null {
  if (event.isSubagent || !event.error) return null;

  switch (event.error.kind) {
    case 'missing-api-key':
      return {
        type: 'instruction',
        payload: {
          key: 'missingApiKey',
          message: MISSING_API_KEY_MESSAGE,
          actions: [
            INSTRUCTION_ACTION.SET_API_KEY,
            INSTRUCTION_ACTION.OPEN_CONFIGURATION_GUIDE,
          ],
          showSuppress: false,
        },
      };
    case 'disk-full':
      return {
        type: 'error',
        payload: { message: event.error.message ?? 'Disk full.' },
      };
    case 'unexpected':
      return {
        type: 'error',
        payload: {
          message: event.error.message ?? 'Unexpected error executing agent.',
        },
      };
    default:
      // 'abort' and any other classified kind: no toast (matches the prior
      // lifecycle behavior, which only toasted these three kinds).
      return null;
  }
}
