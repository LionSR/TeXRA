/**
 * Terminal-result → host presentation mapping, and the session hook that
 * applies it.
 *
 * `terminalResultToast` is the single decision point for the toast a host
 * shows when a run ends in an error. It replaces the per-emission toasts the
 * run lifecycle used to fire: the lifecycle now emits one `result` event, and
 * each host applies this pure mapper in its `session.onResult` consumer,
 * presenting the returned payload through its existing
 * `requestShowInstruction` / `requestShowError` path. Subagent results and
 * non-actionable outcomes (abort, success) return `null` (no toast),
 * preserving the lifecycle's `!isSubagent` gating.
 *
 * `attachTerminalResultToast` wires that mapper to a session for hosts that
 * present through an {@link AgentRuntimeHost} (CLI, desktop). The `session` is
 * load-bearing: desktop passes its per-window session, while CLI/extension
 * pass the process {@link defaultSession}. A helper that hard-coded the
 * default would route desktop to the wrong session and never see its
 * results. Every host presents through its `runtimeHost`; in the extension,
 * `extensionAgentRuntimeHost.emit` routes these presentation requests to the
 * extension presentation handlers exactly once.
 */
import type { ResultEvent } from '@agent/trace';
import {
  INSTRUCTION_ACTION,
  type RequestShowErrorPayload,
  type RequestShowInstructionPayload,
} from '@shared/schemas';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { SessionHandle } from './SessionHandle';

export type TerminalResultToast =
  | {
      readonly type: 'instruction';
      readonly payload: RequestShowInstructionPayload;
    }
  | {
      readonly type: 'error';
      readonly payload: RequestShowErrorPayload;
    };

const MISSING_API_KEY_MESSAGE =
  'API key not found. Set your API key in Settings and run again.';

/**
 * Map a terminal `result` event to the toast a host should present, or `null`
 * when none applies (subagent runs, success, user aborts, unclassified errors).
 */
export function terminalResultToast(
  event: ResultEvent,
): TerminalResultToast | null {
  if (event.isSubagent || !event.error) return null;
  // Bind to a local so the switch below narrows this value's per-kind shape
  // (ResultEvent.error is now a union keyed on `kind`) rather than the
  // `event.error` property-access chain, which narrows less reliably.
  const error = event.error;

  switch (error.kind) {
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
        payload: { message: error.message ?? 'Disk full.' },
      };
    case 'unexpected':
      return {
        type: 'error',
        payload: {
          message: error.message ?? 'Unexpected error executing agent.',
        },
      };
    case 'abort':
      // User-initiated cancellation: no toast (matches the prior lifecycle).
      return null;
    default: {
      // Exhaustiveness guard: a new AgentErrorKind must take an explicit
      // stance here rather than silently falling through to no-toast.
      // Assert on the whole narrowed union (not `error.kind`) — now that
      // `error` itself is a discriminated union, property access on an
      // already-`never`-narrowed object does not type-check.
      const _exhaustive: never = error;
      void _exhaustive;
      return null;
    }
  }
}

/** Returns a detach disposer; callers detach when the run/host tears down. */
export function attachTerminalResultToast(
  session: SessionHandle,
  runtimeHost: AgentRuntimeHost,
): () => void {
  return session.onResult((event) => {
    const toast = terminalResultToast(event);
    if (toast?.type === 'instruction') {
      runtimeHost.emit('requestShowInstruction', toast.payload);
    } else if (toast?.type === 'error') {
      runtimeHost.emit('requestShowError', toast.payload);
    }
  });
}
