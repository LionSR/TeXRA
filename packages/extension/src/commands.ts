// Third-party imports
import { Effect, Schema, Struct } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { API_KEY_PROVIDER_IDS, type ApiKeyProviderId } from '@texra-ai/llm';
import { withLogChannel, withSessionFs } from '@texra-ai/harness/host';
import { downloadArXivSource } from '@commands/latex/arXivCommands';
import { confirmCleanBuild } from '@commands/housekeeping/cleanCommands';
import { launchSetupAssistant } from '@commands/setup/setupAssistantCommand';
import { createSampleProject } from '@commands/system/sampleProjectCommands';
import { setApiKey, removeApiKey } from '@commands/api/apiKeyCommands';
import {
  handleIndentCurrentTeX,
  handleFixCompilation,
  handleGetTeXCount,
} from '@commands/latex/latexCommands';
import { handleCompileTikzFigures } from '@commands/latex/figCommands';
import { cloneOverleafProject } from '@commands/git/gitCommands';
import { openGettingStarted } from '@commands/system/walkthroughCommands';
import type { CommentCommandId } from '@frontend/comments/inlineComments';
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import { decodeLaunchConfig } from '@texra/controllers/session/launchConfig';
import {
  settingsTabByCommand,
  type ExtensionCommandId,
  type SettingsTabCommandId,
} from '@texra/shared/commands/catalog';
import {
  definedHandler,
  dispatchCommandFromRegistry,
  type CommandHandler,
} from '@texra/shared/commands/registry';
import {
  SettingsTargetSchema,
  type SettingsTarget,
} from '@texra/shared/settingsView/settingsTarget';

// Local file imports
import { ProgressViewProvider } from './progressView/ProgressViewProvider';
import type { Session, Sessions, WorkspaceRoots } from '@texra-ai/harness';
import type {
  ProcessRuntime,
  ProcessServices,
  StorageFs,
  WorkspaceFs,
} from '@texra-ai/harness/host';

/**
 * A command's program. The registration boundary below runs it once, over
 * the window's rooted filesystems, and finishes `executeCommand` with its
 * value.
 */
type CommandProgram = Effect.Effect<
  unknown,
  Error,
  ProcessServices | Sessions | WorkspaceFs | StorageFs
>;

/**
 * Every extension command but the comment threads' own, which
 * `inlineComments.ts` registers with the thread VS Code passes them. A new
 * catalog row fails the handler map's `satisfies` until its handler is
 * written.
 */
type RegisteredCommandId = Exclude<ExtensionCommandId, CommentCommandId>;

/*
 * Duplicate-registration audit (#3787 follow-up):
 * Every command id in the handler map below has been verified to have no
 * stale `vscode.commands.registerCommand(...)` call on the single-folder path
 * that installs it; the other direct `registerCommand` call sites there are
 * the comment threads' commands and the walkthrough action. The no-folder
 * welcome path installs its own standalone variants of a few ids, since this
 * map is not installed there.
 */

/**
 * Register every catalog command against `vscode.commands`, routing each
 * invocation through `dispatchCommandFromRegistry` so the dispatch path is
 * identical to the desktop's. The registered callback is the command's one
 * execution boundary: it runs the handler's program over the window's rooted
 * filesystems and returns that promise, so VS Code forwards the program's
 * value and rejection to `executeCommand` callers (the bug fixed by #3782 was
 * a swallowed rejection).
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  progressViewProvider: ProgressViewProvider,
  runtime: ProcessRuntime,
  roots: WorkspaceRoots,
  /** Where this window's runs run. */
  runSession: Session,
): SettingsViewProvider {
  const settingsViewProvider = new SettingsViewProvider(
    context,
    runtime,
    roots,
    progressViewProvider,
  );

  // cast: one row per key of `settingsTabByCommand`, exactly `SettingsTabCommandId`.
  const settingsTabHandlers = Object.fromEntries(
    Object.entries(settingsTabByCommand).map(([id, tab]) => [
      id,
      () => settingsViewProvider.showSettingsView(tab),
    ]),
  ) as Record<SettingsTabCommandId, () => CommandProgram>;

  const handlers = {
    ...settingsTabHandlers,
    // An optional target (`'models/keys'`) lets a caller land on one section.
    'texra.showDashboard': definedHandler(
      Schema.Tuple([Schema.optional(SettingsTargetSchema)]),
      (_, target?: SettingsTarget) =>
        settingsViewProvider.showSettingsView(target),
    ),
    // New Task is the header's "+": the New-task state into view with the
    // launcher's selections as they are.
    'texra.showMainView': () => progressViewProvider.showLauncher(),
    'texra.cleanBuild': () => confirmCleanBuild,
    'texra.auth.chatgpt.signIn': () =>
      settingsViewProvider.signInSubscription('chatgpt'),
    'texra.runSetupAssistant': () =>
      launchSetupAssistant(
        roots,
        runSession,
        progressViewProvider.runValidated,
        progressViewProvider.showConnectModel(),
        progressViewProvider.showProgressView(),
      ),
    'texra.openGettingStarted': () => openGettingStarted(context.extension.id),
    'texra.createSampleProject': () =>
      createSampleProject(context.extensionPath),
    'texra.downloadArXivSource': () => downloadArXivSource(roots),
    'texra.openProgressViewInTab': () => progressViewProvider.popOutToEditor(),
    'texra.indentCurrentTeX': () => handleIndentCurrentTeX(roots),
    'texra.fixCompilation': () =>
      handleFixCompilation(roots, progressViewProvider.runValidated),
    'texra.getTeXCount': () => handleGetTeXCount(roots),
    'texra.compileTikzFigures': () => handleCompileTikzFigures(roots),
    'texra.cloneOverleafProject': () => cloneOverleafProject(),
    'texra.removeApiKey': () => removeApiKey(roots),
    'texra.showProgressView': definedHandler(
      Schema.Tuple([
        Schema.optional(
          Schema.Struct({ inPlace: Schema.optional(Schema.Boolean) }),
        ),
      ]),
      (_, options?: { inPlace?: boolean }) =>
        progressViewProvider.showProgressView({
          inPlace: options?.inPlace ?? false,
        }),
    ),
    'texra.setApiKey': definedHandler(
      Schema.Tuple([Schema.optional(Schema.Literals(API_KEY_PROVIDER_IDS))]),
      (_, provider?: ApiKeyProviderId) => setApiKey(roots, provider),
    ),
    // Without a configuration the command is the composer's accelerator
    // (Cmd+Alt+E): its Send, in the view the user is in. With one, it starts
    // a fresh run of it on the window's launcher and finishes when the run
    // ends; a configuration that does not decode fails the command with the
    // launch's rejection.
    'texra.execute': definedHandler(
      Schema.Tuple([Schema.optional(Schema.Unknown)]),
      (_, config?: unknown) =>
        config === undefined
          ? progressViewProvider.submit()
          : decodeLaunchConfig(config).pipe(
              Effect.flatMap(progressViewProvider.runValidated),
              Effect.flatMap((run) => run.result),
            ),
    ),
  } as const satisfies Record<
    RegisteredCommandId,
    CommandHandler<void, CommandProgram>
  >;

  for (const id of Struct.keys(handlers)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...rawArgs: unknown[]) => {
        const program = dispatchCommandFromRegistry(
          id,
          handlers,
          undefined,
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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ProgressViewProvider.viewType,
      progressViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );
  return settingsViewProvider;
}
