import { defineCommand, showUsage } from 'citty';

import { getVisibleAgents } from '@agent/index';
import { SupabaseClient } from '@auth/SupabaseClient';
import { preflightTeamAvailability } from '@common/teams/TeamAvailabilityPreflight';
import {
  canLaunchTeam,
  teamTexraHostedMissingNames,
} from '@common/teams/TeamPlan';
import { teamHostedNamesForPreflight } from '@common/teams/TeamRoster';
import { createLog } from '@logger/logUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { platform } from '@platform/platform';
import type { ApiAccessMode } from '@shared/schemas';
import { AgentCategory, byCategory } from '@shared/schemas';
import { getFirstRunDone } from '@shared/state/onboardingState';

import {
  firstRunSetupAgentOverride,
  SETUP_AGENT_HANDOFF_NOTICE,
} from '../onboarding/setupContinuation';
import { CliExitCode } from '../runtime/exitCodes';
import { listCliHistoryEntries } from '../runtime/history';
import { initInteractiveCliPlatform } from '../runtime/initPlatform';
import {
  askCliQuestion,
  writeErrorStderr,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import {
  formatInteractiveTerminalFailure,
  interactiveTerminalFailure,
} from '../runtime/terminalRequirements';
import {
  formatCliMultiAgentTeamLaunchBlockMessage,
  readCliMultiAgentPresets,
} from '../runtime/multiAgentPresets';
import {
  loadCliMultiAgentRunPlan,
  loadCliMultiAgentPresetPlanSet,
  writeMissingPresetAgents,
} from '../runtime/multiAgentRunPlan';
import {
  buildCliAccountItems,
  buildCliAgentItems,
  buildCliOrchestrationItems,
  buildCliResumeItems,
  buildCliTeamItems,
} from '../runtime/orchestration';
import {
  getCliModelAccessList,
  selectCliRunnableModel,
  type CliModelAccess,
} from '../runtime/modelAccess';

const log = createLog('orchestrate');
import { effectiveCliApiMode } from '../runtime/apiAccessMode';
import { loadCliApiStatus } from '../runtime/apiStatus';
import { notifyCliUpdate } from '../runtime/updateChecker';
import { resolveChatDefaults } from '../runtime/chatDefaults';
import {
  contextForCliModelAccess,
  readCliModelAccessStatus,
  updateCliModelAccess,
} from '../runtime/modelAccessSelection';
import {
  chatGptSignOutOutcomeMessage,
  signOutCliChatGpt,
} from '../runtime/chatgptLogin';
import {
  grokSignOutOutcomeMessage,
  signOutCliGrok,
} from '../runtime/grokLogin';
import {
  getCliAuthProfile,
  signOutCliSupabase,
  supabaseSignOutOutcomeMessage,
} from '../runtime/supabaseAuth';

import { contextFromArgs } from './_helpers/context';
import { withUsageSections } from './_helpers/dispatch';
import { setExitCode } from './_helpers/exitCode';
import { loginInitFromArgs, runLoginCommand } from './auth';
import {
  INTERACTIVE_AGENT_GLOBAL_ARGS,
  rejectHeadlessOnlyFlags,
} from './_helpers/globalArgs';
import { runResumeExecution } from './resumeExecution';
import { type CliContext } from '../runtime/cliContext';
import type { CliSubscriptionSignOutResult } from '../runtime/subscriptionLogin';

/**
 * Sign-out bindings for the subscription providers the launcher's `account`
 * action can target. The same provider set the `<provider> login|logout`
 * auth-command definitions declare; a new subscription provider adds one row
 * here and its own auth-command definition.
 */
const SUBSCRIPTION_SIGN_OUT = {
  chatgpt: {
    signOut: signOutCliChatGpt,
    outcomeMessage: chatGptSignOutOutcomeMessage,
  },
  grok: {
    signOut: signOutCliGrok,
    outcomeMessage: grokSignOutOutcomeMessage,
  },
} as const satisfies Record<
  'chatgpt' | 'grok',
  {
    readonly signOut: () => Promise<CliSubscriptionSignOutResult>;
    readonly outcomeMessage: (result: CliSubscriptionSignOutResult) => string;
  }
>;

async function canLaunchWithDefaultModel(
  context: CliContext,
  models: readonly CliModelAccess[],
  apiMode: ApiAccessMode,
): Promise<boolean> {
  if (models.length === 0) return true;

  const defaults = await resolveChatDefaults({
    cwd: context.cwd,
    envAgent: context.envAgent,
    envModel: context.envModel,
  });
  try {
    await selectCliRunnableModel(defaults.model, {
      fallbackReason: defaults.modelSource,
      apiMode,
      accessList: models,
    });
    return true;
  } catch (error) {
    log.warn(
      `Unable to select the default CLI model: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function runOrchestration(context: CliContext): Promise<number> {
  const terminalFailure = interactiveTerminalFailure(context);
  if (terminalFailure) {
    writeTextStderr(
      formatInteractiveTerminalFailure(terminalFailure, {
        headlessMessage:
          'texra orchestrate requires an interactive terminal (TTY stdin and stdout). For scripting, use `texra run` or a concrete subcommand.',
        dumbTerminalCommand: 'orchestrate',
      }),
    );
    return CliExitCode.Usage;
  }

  await notifyCliUpdate(context);

  // This is one of the real interactive entry points (see
  // initInteractiveCliPlatform): most branches below mount the chat TUI
  // directly (chat/preset/setupAgentOverride) or hand off to
  // runResumeExecution (which also mounts it), at which point the TUI takes
  // over signal ownership. The `help` and `exit` launcher actions below mount
  // nothing and return instead — the platform's own handler, still installed
  // by initInteractiveCliPlatform, covers those the same way it would a
  // headless command.
  await initInteractiveCliPlatform({ ...context, quietLogs: true });
  // First-run gate: a credential-less interactive user picks sign-in or a key
  // here instead of landing on a launcher full of "login required" models. On
  // success the apiMode/models read below re-reads the freshly-set credentials
  // in-process — the relay / key paths invalidate the relevant caches — so no
  // relaunch is needed.
  const { maybeRunCliOnboarding } = await import('../onboarding/runOnboarding');
  const onboarding = await maybeRunCliOnboarding(context);
  if (onboarding.declined) {
    // The user saw the picker and chose "Skip for now"; the skip summary already
    // printed. Exit cleanly instead of dropping into a launcher full of
    // "login required" models — same opt-out behavior as `texra chat`.
    return CliExitCode.Success;
  }
  // State 1 continuation (docs/prds/2026-06-11-agent-native-onboarding.md): on a true
  // first run the picker hands straight to a chat session owned by the setup
  // agent instead of the launcher. Existing users (firstRunDone backfilled or
  // earned) and users who pinned an agent via env land on the launcher as
  // before. `orchestrate` has no `--agent` flag here; the env override is the
  // only explicit agent pin this entry point honors.
  const setupAgentOverride = firstRunSetupAgentOverride({
    onboardingConfigured: onboarding.configured,
    firstRunDone: getFirstRunDone(platform().globalState),
    pinnedAgent: context.envAgent,
  });
  if (setupAgentOverride) {
    const { runChat } = await import('../chat/tui/runChatTui');
    const result = await runChat(context, {
      agentOverride: setupAgentOverride,
      startupNotice: SETUP_AGENT_HANDOFF_NOTICE,
    });
    return result.exitCode;
  }

  let launcherApiModeOverride: ApiAccessMode | undefined;
  launcher: while (true) {
    const history = await listCliHistoryEntries();
    const presets = readCliMultiAgentPresets();
    const presetPlanSet = await loadCliMultiAgentPresetPlanSet(presets);
    const apiMode = launcherApiModeOverride ?? effectiveCliApiMode(context);
    const launchContext = contextForCliModelAccess(
      context,
      launcherApiModeOverride,
    );
    const presetLaunchBlockReason =
      launchContext.approvalPolicy === 'never'
        ? 'delegation-denied'
        : undefined;
    const [modelAccess, authProfile] = await Promise.all([
      readCliModelAccessStatus(apiMode),
      getCliAuthProfile(),
    ]);
    const toolUseAgents = getVisibleAgents(AgentCategory.ToolUse);
    const accountStatus = {
      texraSignedIn: authProfile.authenticated,
      texraAccountLabel: authProfile.accountLabel,
      texraCredentialSource: authProfile.credentialSource,
      chatGptSignedIn: modelAccess.chatGptSignedIn,
      chatGptAccountLabel: modelAccess.chatGptAccountLabel,
      grokSignedIn: modelAccess.grokSignedIn,
      grokAccountLabel: modelAccess.grokAccountLabel,
    };
    const launcherModelAccess = {
      ...modelAccess,
      texraSignedIn: authProfile.authenticated,
    };
    const items = buildCliOrchestrationItems({
      presetPlans: presetPlanSet.plans,
      history,
      toolUseAgents,
      includeMultiAgentLoginHint: !presetPlanSet.remoteCatalogRefreshAttempted,
      modelAccess: launcherModelAccess,
      account: accountStatus,
      presetLaunchBlockReason,
    });
    // Load the model registry up front so the launcher can offer a model pick
    // after an agent/team choice. Best-effort: an unavailable registry just
    // launches with the default model instead of blocking the launcher.
    const [models, statusLines] = await Promise.all([
      getCliModelAccessList({
        apiMode,
      }).catch((): readonly CliModelAccess[] => []),
      loadCliApiStatus({ apiMode }),
    ]);
    const allowDefaultModelLaunch = await canLaunchWithDefaultModel(
      launchContext,
      models,
      apiMode,
    );
    const { runOrchestrationTui } =
      await import('../orchestration/runOrchestrationTui');
    const action = await runOrchestrationTui(items, {
      models,
      resumeItems: buildCliResumeItems(history),
      agentItems: buildCliAgentItems(toolUseAgents),
      teamItems: buildCliTeamItems(presetPlanSet.plans, {
        includeLoginHint: !presetPlanSet.remoteCatalogRefreshAttempted,
        remoteAgentCatalogAvailable:
          await SupabaseClient.canAccessRemoteAgentCatalog(),
        launchBlockReason: presetLaunchBlockReason,
      }),
      accountItems: buildCliAccountItems(accountStatus),
      apiMode,
      modelAccess: launcherModelAccess,
      version: context.version,
      statusLines,
      allowDefaultModelLaunch,
      colorEnabled: context.stdoutColorEnabled,
    });

    switch (action.kind) {
      case 'chat': {
        const { runChat } = await import('../chat/tui/runChatTui');
        const result = await runChat(launchContext, {
          agentOverride: action.agent,
          modelOverride: action.model,
        });
        return result.exitCode;
      }
      case 'preset': {
        const initialPlan =
          presetPlanSet.plans.find(
            (plan) => plan.preset.id === action.preset,
          ) ??
          (
            await loadCliMultiAgentRunPlan(
              { preset: action.preset },
              { reloadRemoteAgents: false },
            )
          ).plan;
        const preflight = await preflightTeamAvailability({
          initial: initialPlan,
          unresolvedNames: teamTexraHostedMissingNames,
          texraHostedNames: teamHostedNamesForPreflight(initialPlan.preset, [
            ...initialPlan.missingAgents.workflow,
            ...initialPlan.missingAgents.toolUse,
          ]),
          remoteCatalogRefreshAttempted:
            presetPlanSet.remoteCatalogRefreshAttempted,
          canAccessRemoteCatalog: () =>
            SupabaseClient.canAccessRemoteAgentCatalog(),
          choose: async (names) => {
            writeTextStderr(
              `Team ${action.preset} has unavailable TeXRA-hosted members: ${names.join(', ')}.`,
            );
            const answer = (
              await askCliQuestion(
                'Choose: [s] Sign in to TeXRA, [c] Continue with available members, [q] Cancel: ',
              )
            )
              .trim()
              .toLowerCase();
            if (answer === 's' || answer === 'sign-in') return 'sign-in';
            if (answer === 'c' || answer === 'continue') return 'continue';
            return 'cancel';
          },
          signIn: async () => {
            const code = await runLoginCommand(
              launchContext,
              loginInitFromArgs({}),
            );
            return (
              code === CliExitCode.Success &&
              (await SupabaseClient.canAccessRemoteAgentCatalog())
            );
          },
          refresh: async () =>
            (await loadCliMultiAgentRunPlan({ preset: action.preset })).plan,
        });
        if (
          preflight.status === 'choice-required' ||
          preflight.status === 'cancelled'
        ) {
          continue launcher;
        }
        if (preflight.status === 'unavailable') {
          writeTextStderr(
            `Team ${action.preset} is still unavailable after refreshing agents: ${preflight.unavailableNames.join(', ')}.`,
          );
          continue launcher;
        }
        const plan = preflight.value;
        if (!canLaunchTeam(plan)) {
          writeTextStderr(
            formatCliMultiAgentTeamLaunchBlockMessage(plan, {
              requestedPreset: action.preset,
            }),
          );
          continue launcher;
        }
        const rootAgent = plan.rootAgent;
        writeMissingPresetAgents(plan);
        const { runChat } = await import('../chat/tui/runChatTui');
        const result = await runChat(launchContext, {
          agentOverride: rootAgent.name,
          teamName: plan.preset.name,
          modelOverride: action.model,
          cliMultiAgentPresetId: plan.preset.id,
          delegationAgentScope: byCategory((category) => [
            ...plan.agentKeys[category],
          ]),
        });
        return result.exitCode;
      }
      case 'resume':
        return runResumeExecution(launchContext, action.id);
      case 'browse-resumes':
      case 'configure-model-access':
      case 'browse-agents':
      case 'browse-teams':
      case 'browse-accounts':
        continue launcher;
      case 'configure-settings': {
        const { runConfigTui } = await import('../config/runConfigTui');
        await runConfigTui({
          colorEnabled: context.stdoutColorEnabled,
          onError: writeErrorStderr,
        });
        continue launcher;
      }
      case 'account': {
        try {
          if (action.provider === 'chatgpt' || action.provider === 'grok') {
            if (action.operation === 'sign-out') {
              const entry = SUBSCRIPTION_SIGN_OUT[action.provider];
              writeTextStdout(entry.outcomeMessage(await entry.signOut()));
            } else {
              const result = await updateCliModelAccess(
                launchContext,
                {
                  kind: 'subscription-preference',
                  provider: action.provider,
                  state: 'on',
                },
                { writeProgress: writeTextStdout },
              );
              launcherApiModeOverride = result.apiMode;
              writeTextStdout(result.message);
            }
          } else if (action.operation === 'sign-out') {
            await signOutCliSupabase();
            writeTextStdout(
              supabaseSignOutOutcomeMessage('Signed out of TeXRA.'),
            );
          } else {
            await runLoginCommand(launchContext, loginInitFromArgs({}));
          }
          invalidateModelOptionsCache();
        } catch (error: unknown) {
          writeErrorStderr(error);
        }
        continue launcher;
      }
      case 'set-model-access': {
        try {
          const result = await updateCliModelAccess(
            launchContext,
            action.access,
            { writeProgress: writeTextStdout },
          );
          launcherApiModeOverride = result.apiMode;
          writeTextStdout(result.message);
        } catch (error: unknown) {
          writeErrorStderr(error);
        }
        continue launcher;
      }
      case 'help': {
        const { rootCommand } = await import('./root');
        await showUsage(rootCommand);
        return CliExitCode.Success;
      }
      case 'exit':
        return CliExitCode.Success;
    }
  }
}

export const orchestrationCommand = withUsageSections(
  defineCommand({
    meta: {
      name: 'orchestrate',
      description:
        'Interactive launcher (runs by default on bare `texra` in a TTY): pick a chat, resume, or team preset',
    },
    args: {
      ...INTERACTIVE_AGENT_GLOBAL_ARGS,
    },
    async run(ctx) {
      rejectHeadlessOnlyFlags(ctx.rawArgs, 'orchestrate');
      const context = await contextFromArgs(ctx.args, ctx.rawArgs);
      setExitCode(await runOrchestration(context));
    },
  }),
  [
    {
      title: 'INTERACTIVE CONTROLS',
      rows: [
        ['↑/↓', 'navigate launcher items'],
        ['1-9/a-z', 'open an item directly'],
        ['Enter', 'open the selected item'],
        ['Esc', 'exit the launcher'],
      ],
    },
  ],
);
