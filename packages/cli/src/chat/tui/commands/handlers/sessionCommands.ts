// Session-scoped slash commands (`/help`, `/goal`, `/status`, `/compact`),
// wired to their command names in `registerBuiltins`.

import { notifyFollowUpSent } from '@agent/followUp/ToolUseFollowUp';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { formatCliSessionStatus } from '@cli/chat/tui/sessionStatus';
import { requestCliCompaction } from '@cli/chat/tui/state/compactionRequest';
import {
  activeStreamId as activeStreamIdSignal,
  openInfoPane,
  sessionMeta,
  streamAccessTarget,
  streams,
} from '@cli/chat/tui/state/cliState';
import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import {
  isCodexSubscriptionActive,
  isKimiCodeSubscriptionActive,
  isXaiSubscriptionActive,
} from '@model/providerCapabilities';
import { formatTexraApprovalPolicy } from '@shared/approvalPolicy';
import { GoalStore } from '@tools/goal';

import { formatSlashCommandHelp, GOAL_MODE_HELP } from '../helpText';
import { listSlashCommands } from '../slashRegistry';
import { type SlashCommandContext } from './slashContext';

export function showCliSlashCommandHelp(): void {
  openInfoPane(
    '/help',
    formatSlashCommandHelp(listSlashCommands(), {
      shortcutModifierLabel: defaultShortcutModifierLabel(),
      shiftEnterNewline: terminalCapabilities.get().kittyKeyboard,
    }),
  );
}

export function showCliGoalModeHelp(): void {
  openInfoPane('/goal', GOAL_MODE_HELP);
}

export async function showCliSessionStatus(
  context: SlashCommandContext,
): Promise<void> {
  const meta = sessionMeta.get();
  const activeStreamId = activeStreamIdSignal.get();
  const slice = activeStreamId ? streams.get().get(activeStreamId) : undefined;
  const accessTarget = streamAccessTarget(slice, {
    model: meta.model || context.initialModel,
    category: meta.category,
  });
  const subscriptionActive =
    accessTarget.category === undefined
      ? false
      : await isCodexSubscriptionActive(
          accessTarget.model,
          accessTarget.category,
        );
  const grokSubscriptionActive =
    accessTarget.category === undefined
      ? false
      : await isXaiSubscriptionActive(accessTarget.model);
  const kimiCodeActive =
    accessTarget.category === undefined
      ? false
      : await isKimiCodeSubscriptionActive(accessTarget.model);
  appendLocalAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent || context.initialAgent,
      model: accessTarget.model,
      teamName: meta.teamName,
      modelAccess: resolveCliModelAccessRoute({
        apiMode: meta.apiMode,
        subscriptionActive,
        grokSubscriptionActive,
        kimiCodeActive,
        usageRoute: slice?.usage?.usageRoute,
      }),
      approval: formatTexraApprovalPolicy(context.getApprovalPolicy()),
      approvalBypasses: slice?.bypass,
      status: slice?.status ?? 'not started',
      substate: slice?.substate,
      goal: activeStreamId ? GoalStore.getForStream(activeStreamId) : undefined,
      // Only surface the resume id once a stream exists — never next to
      // a "not started" status.
      sessionId:
        slice && meta.transcriptMode === 'persistent'
          ? context.session.executionId
          : undefined,
      commandName: context.commandName,
      cwd: context.cwd,
      processCwd: context.processCwd,
      approvalPolicy: context.getApprovalPolicy(),
      queuedFollowUpMessages:
        activeStreamId === undefined
          ? []
          : defaultSession().followUps.getAll(activeStreamId),
    }),
  );
}

export function requestCliSessionCompaction(): void {
  requestCliCompaction({
    streamId: activeStreamIdSignal.get(),
    requestManualCompaction: (streamId) =>
      defaultSession().executions.requestManualCompaction(streamId),
    notifyFollowUpSent,
    appendTranscript: appendLocalAssistantTranscript,
  });
}
