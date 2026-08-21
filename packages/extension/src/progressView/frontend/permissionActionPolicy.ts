/**
 * Pure protocol policy for the session-bypass-enable messages that accompany
 * a "broader approve" permission decision. Kept separate from
 * `eventHandlers.ts`'s dispatch (`postMessage` side effects) so the ordering
 * guarantee and bypass semantics are readable — and reusable — without
 * reading through the imperative event-handling code around them.
 */

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewInboundMessage } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

/**
 * Build the session-bypass enable that accompanies the broader approve action.
 * The grant covers only the prompt's own kind, so an edit prompt never
 * auto-approves shell commands. Set-on (not toggle) is inversion-proof: a
 * stream can already carry that kind's bypass from the shield or from
 * delegated inheritance. The button only renders with a real stream (see
 * canBypass), but guard anyway.
 */
export function approvalBypassMessage(
  streamId: string | undefined,
  kind: typeof PERMISSION_KIND.TOOL_EDIT | typeof PERMISSION_KIND.BASH,
): ProgressViewInboundMessage | undefined {
  if (!streamId) return undefined;
  return {
    command: PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS,
    stream: streamId,
    kind,
  };
}

/**
 * Order an optional session-bypass-enable message ahead of the terminal
 * protocol message it gates. Webview messages are delivered FIFO to the
 * extension host, and the bypass-enable message sets the per-stream bypass
 * synchronously when handled — so sending it first guarantees it lands
 * before the terminal message unblocks the agent, and the agent can't race
 * ahead and re-prompt the next gated action before bypass is live.
 */
export function orderWithOptionalBypass(
  bypassMessage: ProgressViewInboundMessage | undefined,
  message: ProgressViewInboundMessage,
): ProgressViewInboundMessage[] {
  return bypassMessage ? [bypassMessage, message] : [message];
}
