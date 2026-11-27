// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports - utilities
import { CommandDirs } from '@texra-ai/worldline/node';
import { vscodeOpener } from '@frontend/hosts/VscodeExternalOpener';
import { copyText, vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { inputBox } from '@frontend/ui/dialogs';
import type { HostFailed } from '@texra/hosts/uiHosts';
import { announce, showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import {
  cloneOverleafProject as runOverleafClone,
  type OverleafCloneOutcome,
  type OverleafCloneWorkflowPorts,
} from '@latex/overleafClone';
import { parseLatexGitUrl, type OverleafRemote } from '@latex/overleafProject';
import {
  installAdvice,
  LATEX_TOOL_ENTRIES,
} from '@texra/shared/constants/latexToolchain';
import { osPlatformOf } from '@texra/shared/osPlatform';
import { commandCatalogById } from '@texra/shared/commands/catalog';
import {
  CLONE_COPY,
  cloneProviderLabel,
  overleafCloneNotice,
} from '@ui/copy/clone';
import { hasPackageManager } from '@texra/utils/system/toolChecks';
import {
  Secrets,
  withLogChannel,
  WorkspaceFs,
  type PlatformSecrets,
} from '@texra-ai/worldline/plugins';

const CHANNEL = 'gitCommands';

/** Hand a URL to the browser; a failure is logged, not raised, because the
 *  dialogs that offer it have nothing further to do about one. */
const openUrl = (url: string) =>
  vscodeOpener
    .openExternal(url)
    .pipe(
      Effect.catch((failure) =>
        Effect.logWarning(`Could not open ${url}: ${failure.message}`).pipe(
          withLogChannel(CHANNEL),
        ),
      ),
    );

const promptInput = Effect.fn('promptInput')(function* (
  title: string,
  prompt: string,
  password = false,
): Effect.fn.Return<string | null, HostFailed> {
  const val = yield* inputBox({
    title,
    prompt,
    password,
    ignoreFocusOut: true,
  });
  const trimmed = val?.trim() ?? '';
  if (!trimmed) {
    // Show cancellation message only if user dismissed with empty string (not Escape)
    if (val !== undefined) {
      yield* vscodeUi.notify('warning', CLONE_COPY.cancelled);
    }
    return null;
  }
  return trimmed;
});

const promptGitMissing = Effect.fnUntraced(function* () {
  const platform = osPlatformOf(process.platform);
  const advice = installAdvice('Git', ['git'], platform);
  const downloadUrl = LATEX_TOOL_ENTRIES.git.install.url?.[platform];
  // The command is worth offering only where its package manager is
  // installed.
  const command =
    advice.command &&
    hasPackageManager(advice.command.packageManager, (yield* CommandDirs)())
      ? advice.command.command
      : null;
  const message = CLONE_COPY.gitMissing(platform);

  const actions = [
    ...(command ? (['Copy Command', 'Run in Terminal'] as const) : []),
    ...(downloadUrl ? (['Open git-scm.com'] as const) : []),
  ];

  yield* Effect.logError(message).pipe(withLogChannel(CHANNEL));
  const selected = yield* announce(
    vscodeUi.ask('error', message, { items: actions }),
    undefined,
  );
  if (selected === 'Copy Command' && command) {
    yield* copyText(command).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Could not copy the command: ${error.message}`).pipe(
          withLogChannel(CHANNEL),
        ),
      ),
    );
  } else if (selected === 'Run in Terminal' && command) {
    const terminal = vscode.window.createTerminal('Install Git');
    terminal.show();
    terminal.sendText(command);
  } else if (selected === 'Open git-scm.com' && downloadUrl) {
    yield* openUrl(downloadUrl);
  }
});

/** Wire the shared Overleaf/ShareLaTeX clone workflow to the secret store
 *  and VS Code's input prompts and progress UI. All decision logic (token
 *  validation, precondition checks, auth-failure handling) lives in
 *  `@latex/overleafClone`. */
function buildOverleafClonePorts(
  secrets: PlatformSecrets,
  remote: OverleafRemote,
): OverleafCloneWorkflowPorts {
  return {
    // A credential store this host cannot reach fails the clone with its
    // `SecretsFailed`, which the workflow's `Error` channel carries.
    secrets,
    promptToken: () =>
      promptInput(
        CLONE_COPY.tokenTitle(remote),
        CLONE_COPY.tokenPrompt(remote),
        true,
      ),
    showProgress: (clone) =>
      withVSCodeProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Cloning ${cloneProviderLabel(remote)}…`,
        },
        () => clone,
      ),
  };
}

/** Show the clone's outcome, its links as buttons. A cancelled prompt has
 *  already said so, and a missing git offers this editor's own steps. */
const presentCloneOutcome = Effect.fn('gitCommands.presentCloneOutcome')(
  function* (remote: OverleafRemote, outcome: OverleafCloneOutcome) {
    if (outcome._tag === 'Cancelled') return;
    if (outcome._tag === 'GitMissing') return yield* promptGitMissing();
    const notice = overleafCloneNotice(
      remote,
      outcome,
      osPlatformOf(process.platform),
    );
    const message =
      outcome._tag === 'WorkspaceNotEmpty'
        ? `${notice.message} Open an empty folder, then clone again.`
        : notice.message;
    if (notice.level === 'error') yield* Effect.logError(message);
    if (notice.gitError !== undefined)
      yield* Effect.logError(`Clone failed: ${notice.gitError}`);
    if (notice.links.length === 0)
      return yield* vscodeUi.notify(notice.level, message);
    const picked = yield* announce(
      vscodeUi.ask(notice.level, message, {
        items: notice.links.map((link) => link.label),
      }),
      undefined,
    );
    const link = notice.links.find(({ label }) => label === picked);
    if (link) yield* openUrl(link.url);
  },
  withLogChannel(CHANNEL),
);

export const cloneOverleafProject = Effect.fn('cloneOverleafProject')(
  function* () {
    const input = yield* promptInput(
      commandCatalogById['texra.cloneOverleafProject'].title,
      CLONE_COPY.projectPrompt,
    );
    if (!input) return;

    const remote = parseLatexGitUrl(input);
    if (!remote) {
      yield* showLoggedMessage(CLONE_COPY.invalidProject);
      return;
    }

    // The session's workspace view names the clone target. The view is the
    // one the command root provided; this depth only reads it.
    const workspaceRoot = (yield* WorkspaceFs).root;
    if (!workspaceRoot) {
      yield* showLoggedMessage('Open a project folder first.');
      return;
    }
    const outcome = yield* runOverleafClone(
      remote,
      workspaceRoot,
      buildOverleafClonePorts(yield* Secrets, remote),
    );
    yield* presentCloneOutcome(remote, outcome);
  },
  withLogChannel(CHANNEL),
);
