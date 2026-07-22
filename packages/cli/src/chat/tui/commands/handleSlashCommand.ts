import { notifyFollowUpSent } from '@agent/followUp/ToolUseFollowUp';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { formatCliApprovalPolicy } from '@cli/runtime/approvalPolicyText';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import {
  isCodexSubscriptionActive,
  isKimiCodeSubscriptionActive,
} from '@model/providerCapabilities';
import { GoalStore } from '@tools/goal';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { formatCliSessionStatus } from '../sessionStatus';
import { requestCliCompaction } from '../state/compactionRequest';
import {
  activeStreamId as activeStreamIdSignal,
  openInfoPane,
  sessionMeta,
  setTransientNotice,
  streamAccessTarget,
  streams,
} from '../state/cliState';
import { terminalCapabilities } from '../state/terminalCapabilities';
import { appendLocalAssistantTranscript } from '../state/transcript';
import { formatSlashCommandHelp, GOAL_MODE_HELP } from './helpText';
import { showCliAuthStatus } from './handlers/apiModeCommands';
import { applyCliApprovalPolicySelection } from './handlers/approvalCommand';
import {
  openCanonicalSlashForm,
  type SlashCommandContext,
} from './handlers/slashContext';
import {
  appendSlashCommandEcho,
  openRegisteredCliSlashForm,
} from './slashForms';
import {
  findSlashCommand,
  findRedactedSlashCommandInput,
  listSlashCommands,
  parseSlashInput,
  shouldRedactSlashInput,
  suggestSlashCommand,
  type SlashCommand,
} from './slashRegistry';

/** Run a command body with centralized echo and error persistence. */
async function runGuardedSlashCommand(
  line: string,
  command: SlashCommand | undefined,
  action: () => void | Promise<void>,
): Promise<void> {
  let echoed = false;
  const echo = (): void => {
    if (echoed) return;
    appendSlashCommandEcho(line);
    echoed = true;
  };
  try {
    if (command?.echo === 'ifPersists') echo();
    await action();
  } catch (error: unknown) {
    echo();
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
    setTransientNotice(
      `For safety, /${redactedIntent.name} accepts credentials only through its masked form.`,
    );
    if (
      !openRegisteredCliSlashForm(redactedIntent, '', () =>
        appendSlashCommandEcho(line),
      )
    ) {
      setTransientNotice(
        `/${redactedIntent.name} is not available in this CLI view yet.`,
      );
    }
    return true;
  }

  const command = parsed.name.toLowerCase();
  const rest = parsed.remainder.trim();
  const registered = findSlashCommand(command) ?? redactedIntent;
  const canonicalCommand = registered?.name ?? command;
  const opensRegisteredForm =
    registered?.formName !== undefined &&
    (!rest || registered.formRemainders?.includes(rest.toLowerCase()));
  if (opensRegisteredForm) {
    openCanonicalSlashForm(registered.formName, registered, rest, () =>
      appendSlashCommandEcho(line),
    );
    return true;
  }
  if (rest && registered?.argHandler) {
    await runGuardedSlashCommand(line, registered, () =>
      registered.argHandler?.(rest, context),
    );
    return true;
  }
  switch (canonicalCommand) {
    case 'help': {
      await runGuardedSlashCommand(line, registered, () =>
        openInfoPane(
          '/help',
          formatSlashCommandHelp(listSlashCommands(), {
            shortcutModifierLabel: defaultShortcutModifierLabel(),
            shiftEnterNewline: terminalCapabilities.get().kittyKeyboard,
          }),
        ),
      );
      return true;
    }
    case 'clear':
      await runGuardedSlashCommand(line, registered, context.resetSession);
      return true;
    case 'exit':
      context.session.stopRequested = true;
      context.interruptActive();
      context.requestInputExit();
      return true;
    case 'key':
      if (rest) {
        setTransientNotice(
          'For safety, `/key` does not accept a key as an argument. Enter it in the masked form.',
        );
      }
      openCanonicalSlashForm('key', registered, '');
      return true;
    case 'auth':
      await runGuardedSlashCommand(line, registered, showCliAuthStatus);
      return true;
    case 'yolo':
      await runGuardedSlashCommand(line, registered, () =>
        applyCliApprovalPolicySelection(rest || 'yolo', context),
      );
      return true;
    case 'status':
      await runGuardedSlashCommand(line, registered, async () => {
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
              kimiCodeActive,
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
      await runGuardedSlashCommand(line, registered, () =>
        openInfoPane('/goal', GOAL_MODE_HELP),
      );
      return true;
    case 'compact':
      await runGuardedSlashCommand(line, registered, () =>
        requestCliCompaction({
          streamId: activeStreamIdSignal.get(),
          requestManualCompaction: (streamId) =>
            defaultSession().executions.requestManualCompaction(streamId),
          notifyFollowUpSent,
          appendTranscript: appendLocalAssistantTranscript,
        }),
      );
      return true;
    default: {
      if (registered) {
        if (
          openRegisteredCliSlashForm(registered, parsed.remainder, () =>
            appendSlashCommandEcho(line),
          )
        ) {
          return true;
        }
        await runGuardedSlashCommand(line, registered, () => {
          throw new Error(
            `/${parsed.name} is registered but is not available in this CLI view yet.`,
          );
        });
      } else {
        const suggestion = suggestSlashCommand(command);
        const didYouMean = suggestion
          ? ` Did you mean /${suggestion.name}?`
          : '';
        setTransientNotice(
          shouldRedactSlashInput(line)
            ? 'Unknown command with protected input. Type /help to list commands.'
            : `Unknown command: /${parsed.name}.${didYouMean} Type /help to list commands.`,
        );
      }
      return true;
    }
  }
}
