// Third-party imports
import { Effect, Schema, Struct } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { API_KEY_PROVIDER_IDS, type ApiKeyProviderId } from '@texra-ai/llm';
import { withSessionFs } from '@texra-ai/harness/host';
import {
  withLogChannel,
  type StorageFs,
  type WorkspaceFs,
} from '@texra-ai/harness/plugins';
import { downloadArXivSource } from '@commands/latex/arXivCommands';
import { confirmCleanBuild } from '@commands/housekeeping/cleanCommands';
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
import { SettingsViewProvider } from './settingsView/SettingsViewProvider';
import type { Sessions, WorkspaceRoots } from '@texra-ai/harness';
import type {
  ProcessRuntime,
  ProcessServices,
  ScopedFork,
} from '@texra-ai/harness/host';

/** The log channel of the command registration's own failures. */
const REGISTRY_CHANNEL = 'ExtensionCommandRegistry';

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

/** `texra.setApiKey`, optionally naming the provider to start on: one row
 *  for the folder's window and the window without one. */
export const setApiKeyHandler = (roots: WorkspaceRoots) =>
  definedHandler(
    Schema.Tuple([Schema.optional(Schema.Literals(API_KEY_PROVIDER_IDS))]),
    (_: void, provider?: ApiKeyProviderId) => setApiKey(roots, provider),
  );

/**
 * Register a table of catalog commands against `vscode.commands`, routing
 * each invocation through `dispatchCommandFromRegistry` so the dispatch path
 * is identical to the desktop's: arguments are decoded and a bad payload is
 * reported. The registered callback is the command's one execution
 * boundary: it runs the handler's program over the window's rooted
 * filesystems and returns that promise, so VS Code forwards the program's
 * value and rejection to `executeCommand` callers (the bug fixed by #3782
 * was a swallowed rejection).
 */
export function registerHandlers(
  context: vscode.ExtensionContext,
  runtime: ProcessRuntime,
  fork: ScopedFork<ProcessServices | Sessions>,
  roots: WorkspaceRoots,
  handlers: Partial<
    Record<RegisteredCommandId, CommandHandler<void, CommandProgram>>
  >,
): void {
  for (const id of Struct.keys(handlers)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (...rawArgs: unknown[]) => {
        const program = dispatchCommandFromRegistry(
          id,
          handlers,
          undefined,
          (failure) => {
            if (failure.kind === 'invalidArguments') {
              fork(
                showLoggedMessage(
                  `Invalid arguments for command ${failure.id}: ${failure.error.message}`,
                ).pipe(withLogChannel(REGISTRY_CHANNEL)),
              );
              return;
            }
            fork(
              Effect.logError(
                `No handler is registered for command ${failure.id}`,
              ).pipe(withLogChannel(REGISTRY_CHANNEL)),
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

/**
 * Register every catalog command a folder's window runs, and its views.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  progressViewProvider: ProgressViewProvider,
  runtime: ProcessRuntime,
  /** The activation's run function for VS Code callbacks. */
  fork: ScopedFork<ProcessServices | Sessions>,
  roots: WorkspaceRoots,
): SettingsViewProvider {
  const settingsViewProvider = new SettingsViewProvider(
    context,
    runtime,
    fork,
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
    'texra.runSetupAssistant': () => progressViewProvider.runSetup,
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
    'texra.showProgressView': () => progressViewProvider.showProgressView(),
    'texra.setApiKey': setApiKeyHandler(roots),
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

  registerHandlers(context, runtime, fork, roots, handlers);

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
