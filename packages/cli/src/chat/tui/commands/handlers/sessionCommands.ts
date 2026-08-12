// Session-scoped slash commands (`/help`, `/goal`, `/status`, `/compact`),
// wired to their command names in `registerBuiltins`.

import { defaultSession } from '@agent/runtime';
import { notifyFollowUpSent } from '@agent/followUp/ToolUseFollowUp';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { formatCliSessionStatus } from '@cli/chat/tui/sessionStatus';
import { requestCliCompaction } from '@cli/chat/tui/state/compactionRequest';
import {
  activeStreamId as activeStreamIdSignal,
  beginWorkPlanReaderRequest,
  cancelPendingWorkPlanReaderRequest,
  cancelWorkPlanReaderRequest,
  clearTransientNotice,
  finishWorkPlanReaderRequest,
  openInfoPane,
  sessionMeta,
  setTransientNotice,
  streams,
  workPlanReaderRequestIsCurrent,
} from '@cli/chat/tui/state/cliState';
import {
  hydrateStreamArtifacts,
  type StreamArtifactReader,
} from '@cli/chat/tui/state/subscribeStreamArtifacts';
import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import {
  isCodexSubscriptionActive,
  isKimiCodeSubscriptionActive,
  isXaiSubscriptionActive,
} from '@model/providerCapabilities';
import { formatTexraApprovalPolicy } from '@shared/approvalPolicy';
import { GoalStore } from '@tools/goal';
import { toErrorMessage } from '@utils/errors/errorMessage';

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

export async function showCliWorkPlan(
  snapshots: StreamArtifactReader = defaultSession().snapshots,
): Promise<void> {
  const streamId = activeStreamIdSignal.get();
  if (!streamId) {
    cancelPendingWorkPlanReaderRequest();
    setTransientNotice('No focused session.');
    return;
  }
  clearTransientNotice();
  const request = beginWorkPlanReaderRequest(streamId);
  const hydrated = await hydrateStreamArtifacts(
    snapshots,
    streamId,
    () => workPlanReaderRequestIsCurrent(request),
    (error) => {
      if (!cancelWorkPlanReaderRequest(request)) return;
      setTransientNotice(
        `Could not load workflow artifacts: ${toErrorMessage(error)}`,
      );
    },
  );
  if (!hydrated || !workPlanReaderRequestIsCurrent(request)) return;
  const slice = streams.get().get(streamId);
  if (!slice || (slice.plan === null && slice.todos.length === 0)) {
    if (!cancelWorkPlanReaderRequest(request)) return;
    setTransientNotice('The focused session has no work plan.');
    return;
  }
  finishWorkPlanReaderRequest(request);
}

export async function showCliSessionStatus(
  context: SlashCommandContext,
): Promise<void> {
  const meta = sessionMeta.get();
  const activeStreamId = activeStreamIdSignal.get();
  const slice = activeStreamId ? streams.get().get(activeStreamId) : undefined;
  // Use root-session access facts only before any stream exists.
  const model = slice?.model ?? (meta.model || context.initialModel);
  const subscriptionActive = await isCodexSubscriptionActive(model);
  const grokSubscriptionActive = await isXaiSubscriptionActive(model);
  const kimiCodeActive = await isKimiCodeSubscriptionActive(model);
  appendLocalAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent || context.initialAgent,
      model,
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
