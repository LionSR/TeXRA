import { notifyFollowUpSent } from '@agent/followUp/ToolUseFollowUp';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { formatCliApprovalPolicy } from '@cli/runtime/approvalPolicyText';
import { parseCliHistoryId } from '@cli/runtime/history';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { isCodexSubscriptionActive } from '@model/codexSubscriptionActive';
import { GoalStore } from '@tools/goal';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { formatCliSessionStatus } from '../sessionStatus';
import { requestCliCompaction } from '../state/compactionRequest';
import {
  activeStreamId as activeStreamIdSignal,
  sessionMeta,
  streamAccessTarget,
  streams,
} from '../state/cliState';
import { chatTuiCanStartRootRun } from '../state/sessionRunState';
import { terminalCapabilities } from '../state/terminalCapabilities';
import {
  appendLocalAssistantTranscript,
  appendLocalUserTranscript,
} from '../state/transcript';
import { formatSlashCommandHelp, GOAL_MODE_HELP } from './helpText';
import { applyInitialCliAgentSelection } from './handlers/agentModelCommands';
import {
  applyCliApiModeSelection,
  showCliAuthStatus,
} from './handlers/apiModeCommands';
import { applyCliApprovalPolicySelection } from './handlers/approvalCommand';
import { loginFromChat, logoutFromChat } from './handlers/loginCommands';
import {
  showCliMemoryList,
  showCliMemoryPreview,
} from './handlers/memoryCommands';
import {
  openCanonicalSlashForm,
  type SlashCommandContext,
} from './handlers/slashContext';
import { applyCliSubscriptionToggle } from './handlers/subscriptionCommand';
import { openRegisteredCliSlashForm } from './slashForms';
import {
  findSlashCommand,
  findRedactedSlashCommandInput,
  listSlashCommands,
  parseSlashInput,
  shouldRedactSlashInput,
  suggestSlashCommand,
} from './slashRegistry';

/** Run an async command body, surfacing any failure as a transcript message. */
async function runGuardedSlashCommand(
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    appendLocalAssistantTranscript(toErrorMessage(error));
  }
}

export async function handleTuiSlashCommand(
  line: string,
  context: SlashCommandContext,
): Promise<boolean> {
  const redactedIntent = findRedactedSlashCommandInput(line);
  const parsed = parseSlashInput(line);
  if (!parsed) {
    if (!redactedIntent) return false;
    appendLocalAssistantTranscript(
      `For safety, /${redactedIntent.name} accepts credentials only through its masked form.`,
    );
    if (!openRegisteredCliSlashForm(redactedIntent, '')) {
      appendLocalAssistantTranscript(
        `/${redactedIntent.name} is not available in this CLI view yet.`,
      );
    }
    return true;
  }

  const command = parsed.name.toLowerCase();
  const rest = parsed.remainder.trim();
  const registered = findSlashCommand(command) ?? redactedIntent;
  const canonicalCommand = registered?.name ?? command;
  // Echo the slash input into the transcript so the user can see what they
  // typed. Slash commands don't go through the agent run, so the usual
  // USER_MESSAGE stream-log entry is never produced. Skip the echo for the
  // exit commands (the TUI is tearing down); /clear still echoes because
  // resetSessionForClear refuses while a run is active and surfaces an
  // error — without the echo the user wouldn't see what triggered it.
  if (
    canonicalCommand !== 'exit' &&
    canonicalCommand !== 'login' &&
    !shouldRedactSlashInput(line)
  ) {
    appendLocalUserTranscript(line.trim());
  }
  switch (canonicalCommand) {
    case 'help': {
      appendLocalAssistantTranscript(
        formatSlashCommandHelp(listSlashCommands(), {
          shortcutModifierLabel: defaultShortcutModifierLabel(),
          shiftEnterNewline: terminalCapabilities.get().kittyKeyboard,
        }),
      );
      return true;
    }
    case 'clear':
      context.resetSession();
      return true;
    case 'exit':
      context.session.stopRequested = true;
      context.interruptActive();
      context.requestInputExit();
      return true;
    case 'agent':
      if (!chatTuiCanStartRootRun(context.session) && rest) {
        appendLocalAssistantTranscript(
          'The agent is fixed for this chat session. Start a new chat to use a different agent.',
        );
      } else if (rest) {
        applyInitialCliAgentSelection(rest, context);
      } else {
        openCanonicalSlashForm('agent', registered, rest);
      }
      return true;
    case 'model':
      openCanonicalSlashForm('model', registered, rest);
      return true;
    case 'api':
      if (!rest) {
        openCanonicalSlashForm('api', registered, rest);
        return true;
      }
      await runGuardedSlashCommand(() =>
        applyCliApiModeSelection(rest, context),
      );
      return true;
    case 'key':
      if (rest) {
        appendLocalAssistantTranscript(
          'For safety, `/key` does not accept a key as an argument. Enter it in the masked form.',
        );
      }
      openCanonicalSlashForm('key', registered, '');
      return true;
    case 'subscription':
      await runGuardedSlashCommand(() => applyCliSubscriptionToggle(rest));
      return true;
    case 'auth':
      await runGuardedSlashCommand(showCliAuthStatus);
      return true;
    case 'login':
      if (!rest) {
        openCanonicalSlashForm('login', registered, rest);
        return true;
      }
      await loginFromChat(rest, context.cliContext);
      return true;
    case 'logout':
      await logoutFromChat();
      return true;
    case 'approval':
      if (rest) {
        applyCliApprovalPolicySelection(rest, context);
      } else {
        openCanonicalSlashForm('approval', registered, rest);
      }
      return true;
    case 'yolo':
      applyCliApprovalPolicySelection(rest || 'yolo', context);
      return true;
    case 'status':
      await runGuardedSlashCommand(async () => {
        const meta = sessionMeta.get();
        const activeStreamId = activeStreamIdSignal.get();
        const slice = activeStreamId
          ? streams.get().get(activeStreamId)
          : undefined;
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
        appendLocalAssistantTranscript(
          formatCliSessionStatus({
            agent: meta.agent || context.initialAgent,
            model: accessTarget.model,
            teamName: meta.teamName,
            modelAccess: resolveCliModelAccessRoute({
              apiMode: meta.apiMode,
              subscriptionActive,
              usageRoute: slice?.usage?.usageRoute,
            }),
            approval: formatCliApprovalPolicy(context.getApprovalPolicy()),
            approvalBypasses: slice?.bypass,
            status: slice?.status ?? 'not started',
            substate: slice?.substate,
            goal: activeStreamId
              ? GoalStore.getForStream(activeStreamId)
              : undefined,
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
      });
      return true;
    case 'goal':
      appendLocalAssistantTranscript(GOAL_MODE_HELP);
      return true;
    case 'resume': {
      if (!rest) {
        openCanonicalSlashForm('resume', registered, rest);
        return true;
      }
      const id = parseCliHistoryId(rest);
      if (!id) {
        appendLocalAssistantTranscript(`Invalid execution id: ${rest}`);
        return true;
      }
      await context.resumeExecution(id);
      return true;
    }
    case 'memory':
      await runGuardedSlashCommand(async () => {
        if (!rest) {
          openCanonicalSlashForm('memory', registered, rest);
        } else if (rest.toLowerCase() === 'list') {
          await showCliMemoryList();
        } else {
          await showCliMemoryPreview(rest);
        }
      });
      return true;
    case 'compact':
      requestCliCompaction({
        streamId: activeStreamIdSignal.get(),
        requestManualCompaction: (streamId) =>
          defaultSession().executions.requestManualCompaction(streamId),
        notifyFollowUpSent,
        appendTranscript: appendLocalAssistantTranscript,
      });
      return true;
    default: {
      if (registered) {
        if (openRegisteredCliSlashForm(registered, parsed.remainder)) {
          return true;
        }
        appendLocalAssistantTranscript(
          `/${parsed.name} is registered but is not available in this CLI view yet.`,
        );
      } else {
        const suggestion = suggestSlashCommand(command);
        const didYouMean = suggestion
          ? ` Did you mean /${suggestion.name}?`
          : '';
        appendLocalAssistantTranscript(
          shouldRedactSlashInput(line)
            ? 'Unknown command with protected input. Type /help to list commands.'
            : `Unknown command: /${parsed.name}.${didYouMean} Type /help to list commands.`,
        );
      }
      return true;
    }
  }
}
