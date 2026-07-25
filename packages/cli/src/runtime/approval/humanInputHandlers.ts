import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

import { type CliContext } from '../cliContext';

import {
  approvalPromptAllowed,
  humanInputDenialFeedback,
} from './approvalPolicy';

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
  if (approvalPromptAllowed(context)) return false;
  const feedback = humanInputDenialFeedback(
    context,
    EXTERNAL_INQUIRY_YOLO_MESSAGE,
  );
  void handleExternalInquiryAction({ action: 'drop', threadId, feedback });
  return true;
}
