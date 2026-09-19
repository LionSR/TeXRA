// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import {
  signIn as authSignIn,
  signOut as authSignOut,
} from '@commands/auth/authCommands';
import { handleCreateAgentWithAI as agentHandleCreateAgentWithAI } from '@commands/agent/agentCreatorCommands';
import { runExecuteCommand as agentRunExecuteCommand } from '@commands/agent/executeCommand';
import { downloadArXivSource as latexDownloadArXivSource } from '@commands/latex/arXivCommands';
import { launchSetupAssistant } from '@commands/setup/setupAssistantCommand';
import { createSampleProject as sysCreateSampleProject } from '@commands/system/sampleProjectCommands';
import { showImportOptions as sysShowImportOptions } from '@commands/system/mainViewCommands';
import { handleClean as fileHandleClean } from '@commands/housekeeping/cleanCommands';
import { handlePack as fileHandlePack } from '@commands/housekeeping/packCommands';
import {
  handleAcceptEdited as latexHandleAcceptEdited,
  handleCompare as latexHandleCompare,
} from '@commands/latex/compareCommands';
import {
  setApiKey as apiSetApiKey,
  removeApiKey as apiRemoveApiKey,
} from '@commands/api/apiKeyCommands';
import {
  handleIndentTeX,
  handleIndentCurrentTeX as latexIndentCurrentTeX,
  handleFixCompilation as latexFixCompilation,
  handleGetTeXCount as latexGetTeXCount,
} from '@commands/latex/latexCommands';
import {
  handleExtractTikzFigures as latexExtractTikzFigures,
  handleCompileTikzFigures as latexCompileTikzFigures,
} from '@commands/latex/figCommands';
import { cloneOverleafProject as gitCloneOverleafProject } from '@commands/git/gitCommands';
import { openGettingStarted as sysOpenGettingStarted } from '@commands/system/walkthroughCommands';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { runCleanBuild } from '@housekeeping/clean';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import {
  withSessionFs,
  type StorageFs,
  type WorkspaceFs,
} from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { dispatchCommandFromRegistry } from '@shared/commands/registry';

// Local file imports
import {
  EXTENSION_COMMAND_HANDLERS,
  type ExtensionCommandActions,
} from './extensionCommandHandlers';

export function createExtensionCommandActions(
  context: vscode.ExtensionContext,
  globalState: StateStore,
  settingsViewProvider: SettingsViewProvider,
  progressViewProvider: ProgressViewProvider,
  secrets: PlatformSecrets,
  runtime: ProcessRuntime,
  session: SessionHandle,
): ExtensionCommandActions {
  const refreshAfterProviderKeyChange = (provider: string) =>
    settingsViewProvider.refreshAfterProviderKeyChange(provider);

  /**
   * Settle a housekeeping program over the session's rooted filesystems.
   */
  const onSessionFiles = <A, E>(
    program: Effect.Effect<A, E, WorkspaceFs | StorageFs | ProcessServices>,
  ): Promise<A> => runtime.runPromise(withSessionFs(session.roots, program));

  return {
    showSettings(tab, agentSubTab) {
      return settingsViewProvider.showSettingsView(tab, agentSubTab);
    },
    // New Session is the header's "+" (PRD 12.4): the New-task state into
    // view with the launcher's selections as they are.
    resetMainView: () =>
      runtime.runPromise(progressViewProvider.showLauncher()),
    cleanBuild: () => onSessionFiles(runCleanBuild),
    pack: (config) => onSessionFiles(fileHandlePack(config)),
    clean: (config) => onSessionFiles(fileHandleClean(config)),
    compare: (baseLocation, editedLocation) =>
      runtime.runPromise(latexHandleCompare(baseLocation, editedLocation)),
    acceptEdited: (baseLocation, editedLocation, copyMeta) =>
      runtime.runPromise(
        latexHandleAcceptEdited(baseLocation, editedLocation, copyMeta),
      ),
    indentTeX: () => runtime.runPromise(handleIndentTeX(session)),
    signIn: () => runtime.runPromise(authSignIn),
    signInChatGpt: () => settingsViewProvider.signInSubscription('chatgpt'),
    signInGrok: () => settingsViewProvider.signInSubscription('grok'),
    signOut: () => runtime.runPromise(authSignOut),
    runSetupAssistant: () =>
      runtime.runPromise(
        launchSetupAssistant(secrets, globalState, runtime, session).pipe(
          Effect.asVoid,
        ),
      ),
    openGettingStarted: () => sysOpenGettingStarted(context.extension.id),
    createSampleProject: () =>
      runtime.runPromise(
        sysCreateSampleProject(context.extensionPath, session),
      ),
    downloadArXivSource: () =>
      runtime.runPromise(latexDownloadArXivSource(session, runtime)),
    openProgressViewInTab: () =>
      runtime.runPromise(progressViewProvider.popOutToEditor()),
    async openDoc(page) {
      if (!page) return;
      await vscode.env.openExternal(
        vscode.Uri.parse(`https://texra.ai/guide/${page}.html`),
      );
    },
    indentCurrentTeX: () => runtime.runPromise(latexIndentCurrentTeX(session)),
    fixCompilation: () => runtime.runPromise(latexFixCompilation(session)),
    getTeXCount: () => runtime.runPromise(latexGetTeXCount(session, runtime)),
    extractTikzFigures: () =>
      runtime.runPromise(latexExtractTikzFigures(session)),
    compileTikzFigures: () =>
      runtime.runPromise(latexCompileTikzFigures(session, runtime)),
    cloneOverleafProject: () =>
      runtime.runPromise(gitCloneOverleafProject(session, secrets)),
    removeApiKey: () =>
      runtime.runPromise(
        apiRemoveApiKey(session.roots, secrets, refreshAfterProviderKeyChange),
      ),
    showImportOptions: sysShowImportOptions,
    toggleView: () => runtime.runPromise(progressViewProvider.toggleDrawer()),
    showProgressView: (inPlace) =>
      runtime.runPromise(progressViewProvider.showProgressView({ inPlace })),
    setApiKey: (provider) =>
      apiSetApiKey(
        session.roots,
        secrets,
        refreshAfterProviderKeyChange,
        runtime,
        provider,
      ),
    // The wizard is an Effect program; the host entry's runtime, threaded in
    // from `activate`, settles it here at the command boundary.
    createAgentWithAI: (category) =>
      runtime.runPromise(
        agentHandleCreateAgentWithAI(
          context,
          globalState,
          category,
          secrets,
          session,
        ),
      ),
    // Without a configuration the command is the composer's accelerator
    // (Cmd+Alt+E): its Send, in the view the user is in.
    execute: (input) =>
      input === undefined
        ? runtime.runPromise(progressViewProvider.submit())
        : runtime.runPromise(agentRunExecuteCommand(input, session)),
  };
}

/*
 * Duplicate-registration audit (#3787 follow-up):
 * Every command id in `EXTENSION_COMMAND_HANDLERS` has been verified to
 * have no stale `vscode.commands.registerCommand(...)` call on the
 * single-folder path that installs this registry, and every other direct
 * `registerCommand` call site there registers an id NOT tagged
 * `extensionRegistry` in `commandCatalog` — they're legitimate VS Code-only
 * handlers (git, file selection/opening, merge, and LaTeX tools). The
 * no-folder welcome path installs its own standalone variants of a few
 * tagged ids, since this registry is not installed there.
 */

/**
 * Register every command in the shared registry against `vscode.commands`,
 * routing each invocation through `dispatchCommandFromRegistry` so the
 * dispatch path is identical to the desktop's. The registered callback
 * returns the dispatch result (a `boolean | Promise<boolean>`) so VS Code
 * forwards the underlying promise to `executeCommand` callers — async
 * rejections propagate instead of being swallowed (the bug fixed by
 * #3782).
 */
export function registerExtensionCommandRegistry(
  context: vscode.ExtensionContext,
  actions: ExtensionCommandActions,
  runtime: ProcessRuntime,
): void {
  for (const id of Object.keys(EXTENSION_COMMAND_HANDLERS) as ReadonlyArray<
    keyof typeof EXTENSION_COMMAND_HANDLERS
  >) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...rawArgs: unknown[]) =>
        dispatchCommandFromRegistry(
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
            console.error(
              `[extension] dispatch: unhandled command ${failure.id}`,
            );
          },
          ...rawArgs,
        ),
      ),
    );
  }
}
