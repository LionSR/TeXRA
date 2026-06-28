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
import {
  INSTRUCTION_ACTION,
  type ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

export type TerminalResultErrorKind =
  | 'abort'
  | 'disk-full'
  | 'missing-api-key'
  | 'unexpected';

export interface TerminalResultEvent {
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  readonly isSubagent: boolean;
  readonly error?: {
    readonly kind: TerminalResultErrorKind;
    readonly message?: string;
  };
}

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
  event: TerminalResultEvent,
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
    case 'abort':
      // User-initiated cancellation: no toast (matches the prior lifecycle).
      return null;
    default: {
      // Exhaustiveness guard: a new AgentErrorKind must take an explicit stance
      // here rather than silently falling through to no-toast.
      const _exhaustive: never = event.error.kind;
      void _exhaustive;
      return null;
    }
  }
}
