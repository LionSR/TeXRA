// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel, withSessionFs } from '@texra-ai/harness';
import { runExecuteCommand as agentRunExecuteCommand } from '@commands/agent/executeCommand';
import { downloadArXivSource as latexDownloadArXivSource } from '@commands/latex/arXivCommands';
import { confirmCleanBuild } from '@commands/housekeeping/cleanCommands';
import {
  launchSetupAssistant,
  SETUP_ASSISTANT_CHANNEL,
} from '@commands/setup/setupAssistantCommand';
import { createSampleProject as sysCreateSampleProject } from '@commands/system/sampleProjectCommands';
import {
  setApiKey as apiSetApiKey,
  removeApiKey as apiRemoveApiKey,
} from '@commands/api/apiKeyCommands';
import {
  handleIndentCurrentTeX as latexIndentCurrentTeX,
  handleFixCompilation as latexFixCompilation,
  handleGetTeXCount as latexGetTeXCount,
} from '@commands/latex/latexCommands';
import { handleCompileTikzFigures as latexCompileTikzFigures } from '@commands/latex/figCommands';
import { cloneOverleafProject as gitCloneOverleafProject } from '@commands/git/gitCommands';
import { openGettingStarted as sysOpenGettingStarted } from '@commands/system/walkthroughCommands';
import { openGuidePage } from '@frontend/hosts/VscodeExternalOpener';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { dispatchCommandFromRegistry } from '@texra/shared/commands/registry';

// Local file imports
import {
  EXTENSION_COMMAND_HANDLERS,
  type ExtensionCommandActions,
} from './extensionCommandHandlers';
import type {
  ProcessRuntime,
  Session,
  PlatformSecrets,
  WorkspaceRoots,
} from '@texra-ai/harness';

export function createExtensionCommandActions(
  context: vscode.ExtensionContext,
  settingsViewProvider: SettingsViewProvider,
  progressViewProvider: ProgressViewProvider,
  secrets: PlatformSecrets,
  roots: WorkspaceRoots,
  /** Where this window's runs run. */
  runSession: Session,
): ExtensionCommandActions {
  return {
    showSettings: (tab) => settingsViewProvider.showSettingsView(tab),
    // New Task is the header's "+" (PRD 12.4): the New-task state into
    // view with the launcher's selections as they are.
    newTask: () => progressViewProvider.showLauncher(),
    cleanBuild: () => confirmCleanBuild,
    signInChatGpt: () => settingsViewProvider.signInSubscription('chatgpt'),
    // The launch returns once the setup conversation ends, which may have
    // completed a first task, so the onboarding funnel recomputes then.
    runSetupAssistant: () =>
      launchSetupAssistant(
        secrets,
        roots,
        runSession,
        (runId) =>
          Effect.sync(() => progressViewProvider.presentLaunchedRun(runId)),
        progressViewProvider.showConnectModel(),
        progressViewProvider.showProgressView(),
      ).pipe(
        Effect.andThen(
          progressViewProvider.refreshOnboardingFunnel().pipe(
            Effect.ignore({
              log: 'Warn',
              message: 'Refreshing the onboarding state',
            }),
            withLogChannel(SETUP_ASSISTANT_CHANNEL),
          ),
        ),
      ),
    openGettingStarted: () => sysOpenGettingStarted(context.extension.id),
    createSampleProject: () => sysCreateSampleProject(context.extensionPath),
    downloadArXivSource: () => latexDownloadArXivSource(roots),
    openProgressViewInTab: () => progressViewProvider.popOutToEditor(),
    openDoc: (page) => (page ? openGuidePage(page) : Effect.void),
    indentCurrentTeX: () => latexIndentCurrentTeX(roots),
    fixCompilation: () =>
      latexFixCompilation(roots, progressViewProvider.runValidated),
    getTeXCount: () => latexGetTeXCount(roots),
    compileTikzFigures: () => latexCompileTikzFigures(roots),
    cloneOverleafProject: () => gitCloneOverleafProject(secrets),
    removeApiKey: () => apiRemoveApiKey(roots, secrets),
    showProgressView: (inPlace) =>
      progressViewProvider.showProgressView({ inPlace }),
    setApiKey: (provider) => apiSetApiKey(roots, secrets, provider),
    // Without a configuration the command is the composer's accelerator
    // (Cmd+Alt+E): its Send, in the view the user is in.
    execute: (input) =>
      input === undefined
        ? progressViewProvider.submit()
        : agentRunExecuteCommand(input, progressViewProvider.runValidated),
  };
}

/*
 * Duplicate-registration audit (#3787 follow-up):
 * Every command id in `EXTENSION_COMMAND_HANDLERS` has been verified to
 * have no stale `vscode.commands.registerCommand(...)` call on the
 * single-folder path that installs this registry, and every other direct
 * `registerCommand` call site there registers an id NOT tagged
 * `extensionRegistry` in `commandCatalog` (inline comments and the
 * walkthrough action). The no-folder welcome path installs its own
 * standalone variants of a few tagged ids, since this registry is not
 * installed there.
 */

/**
 * Register every command in the shared registry against `vscode.commands`,
 * routing each invocation through `dispatchCommandFromRegistry` so the
 * dispatch path is identical to the desktop's. The registered callback is
 * the command's one execution boundary: it runs the handler's program over
 * the window's rooted filesystems and returns that promise, so VS Code
 * forwards the program's value and rejection to `executeCommand` callers
 * (the bug fixed by #3782 was a swallowed rejection).
 */
export function registerExtensionCommandRegistry(
  context: vscode.ExtensionContext,
  actions: ExtensionCommandActions,
  runtime: ProcessRuntime,
  roots: WorkspaceRoots,
): void {
  for (const id of Object.keys(EXTENSION_COMMAND_HANDLERS) as ReadonlyArray<
    keyof typeof EXTENSION_COMMAND_HANDLERS
  >) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...rawArgs: unknown[]) => {
        const program = dispatchCommandFromRegistry(
          id,
          EXTENSION_COMMAND_HANDLERS,
          actions,
          (failure) => {
            if (failure.kind === 'invalidArguments') {
              runtime.runFork(
                showLoggedMessage(
                  'ExtensionCommandRegistry',
                  `Invalid arguments for command ${failure.id}: ${failure.error.message}`,
                ),
              );
              return;
            }
            runtime.runFork(
              Effect.logError(
                `No handler is registered for command ${failure.id}`,
              ).pipe(withLogChannel('ExtensionCommandRegistry')),
            );
          },
          ...rawArgs,
        );
        return program === false
          ? false
          : runtime.runPromise(withSessionFs(roots, program));
      }),
    );
  }
}
