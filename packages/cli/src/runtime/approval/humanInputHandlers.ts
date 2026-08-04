import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  decideHumanInputRequest,
  texraHumanInputDenialMessage,
} from '@shared/approvalPolicy';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import { type CliContext } from '../cliContext';

import { markApprovalDenied } from './approvalPrompts';

const EXTERNAL_INQUIRY_YOLO_MESSAGE =
  'External inquiry requires human input; yolo mode cannot synthesize an external answer.';

/**
 * "No human input available" guard for external-inquiry requests, used by the
 * TUI approval queue (`subscribeApprovals.ts`). Drops the durable inquiry
 * thread with denial feedback and returns `true` when denied; returns `false`
 * when a prompt is allowed and the caller should proceed with its own
 * handling. Non-TUI runs never reach here — the headless interaction port
 * drops the thread itself (`approvalAdapter.openExternalInquiry`).
 */
export function denyExternalInquiryIfNoHumanInput(
  threadId: string,
  context: CliContext,
): boolean {
  const decision = decideHumanInputRequest({
    policy: defaultSession().approvalPolicy,
    canPresent: context.mode === 'interactive',
  });
  if (decision === 'present') return false;
  if (decision.deny !== 'yolo-no-human') {
    markApprovalDenied(context);
  }
  void handleExternalInquiryAction({
    action: 'drop',
    threadId,
    feedback: texraHumanInputDenialMessage(
      decision.deny,
      EXTERNAL_INQUIRY_YOLO_MESSAGE,
    ),
  });
  return true;
}
