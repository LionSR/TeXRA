// Third-party imports
import { Effect, Schema } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel } from '@texra-ai/harness';
import { AgentConfigSchema } from '@texra-ai/harness/schemas';
import { runGuardedLatexCommand } from '@frontend/editor/activeFileGuards';
import {
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { quickPick } from '@frontend/ui/dialogs';
import { withVSCodeProgress } from '@frontend/ui/progress';
import {
  getTeXCount,
  parseTeXCountStats,
  type TexcountMode,
} from '@latex/texcount';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import { resolveLatexFormatter } from '@latex/formatter/texFormatter';
import { buildLatexdiffAwareFixInstruction } from '@latex/latexdiff/diffFileNameManager';
import type { HostRunActions } from '@texra/controllers/session/hostRunActions';
import type { ProcessServices, WorkspaceRoots } from '@texra-ai/harness';

export function handleFixCompilation(
  roots: WorkspaceRoots,
  /** The window's launcher, which the fixer run starts on. */
  launch: HostRunActions['runValidated'],
): Effect.Effect<void, Error, ProcessServices> {
  return runGuardedLatexCommand(
    roots,
    {
      channel: CHANNEL,
      action: 'fix compilation',
      saveDocument: true,
      errorMessage: 'Error launching LaTeX compilation fixer',
    },
    ({ editor, relativePath }) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(
          `Launching agent to fix compilation for: ${relativePath}`,
        ).pipe(withLogChannel(CHANNEL));

        const instruction = yield* buildLatexdiffAwareFixInstruction(
          `Fix the LaTeX compilation errors in ${relativePath}.`,
          editor.document.fileName,
          roots.workspace,
        );

        // This is a "run latexFixer" command, so prefer the helper model.
        // The command settles when the run ends.
        const config = yield* Schema.decodeUnknownEffect(AgentConfigSchema)({
          agent: 'latexFixer',
          instruction,
        });
        const run = yield* launch({ config }, { helperModel: true });
        yield* run.result;
      }),
  );
}

export function handleIndentCurrentTeX(
  roots: WorkspaceRoots,
): Effect.Effect<void, Error, ProcessServices> {
  return runGuardedLatexCommand(
    roots,
    {
      channel: CHANNEL,
      action: 'indent LaTeX document',
      saveDocument: true,
      errorMessage: 'Error formatting the LaTeX file',
    },
    ({ relativePath }) =>
      Effect.gen(function* () {
        yield* Effect.logDebug(`Indenting LaTeX file: ${relativePath}`).pipe(
          withLogChannel(CHANNEL),
        );

        // An explicit user action: a disabled formatter notifies instead of
        // succeeding quietly.
        const formatter = yield* resolveLatexFormatter(roots);
        if (!formatter) {
          yield* showLoggedInfoMessage(
            CHANNEL,
            'LaTeX formatter is disabled; no file was indented',
          );
          return;
        }

        const success = yield* formatter.run(
          relativePath,
          roots.workspace,
          formatter.configPath,
          roots,
        );

        if (success) {
          yield* Effect.sleep(100);
          yield* showLoggedInfoMessage(
            CHANNEL,
            'LaTeX file indented successfully',
          );
        } else {
          yield* showLoggedMessage(CHANNEL, 'Failed to indent LaTeX file');
        }
      }),
  );
}

export function handleGetTeXCount(
  roots: WorkspaceRoots,
): Effect.Effect<void, Error, ProcessServices> {
  return runGuardedLatexCommand(
    roots,
    {
      channel: CHANNEL,
      action: 'get TeX count',
      errorMessage: 'Error getting tex count',
    },
    ({ relativePath }) =>
      Effect.gen(function* () {
        yield* Effect.logDebug(`Getting tex count for: ${relativePath}`).pipe(
          withLogChannel(CHANNEL),
        );

        const countingMode = yield* quickPick<
          vscode.QuickPickItem & { value: TexcountMode }
        >(
          [
            { label: 'Count main file only', value: 'separate' as const },
            {
              label: 'Follow \\input/\\include and combine',
              value: 'include' as const,
            },
          ],
          {
            placeHolder: 'Count options',
            canPickMany: false,
          },
        );

        if (!countingMode) {
          return;
        }

        // The notification lives for exactly as long as the body below, which
        // is a step of this program rather than a nested settle.
        yield* withVSCodeProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Counting LaTeX Document',
            cancellable: false,
          },
          (progress) =>
            Effect.gen(function* () {
              progress.report({ message: 'Running texcount...' });

              const { output, errors } = yield* getTeXCount(
                roots.workspace,
                relativePath,
                {
                  mode: countingMode.value,
                  settings: roots,
                },
              );

              if (!output) {
                const message =
                  errors[0] ??
                  'Failed to get tex count. Please verify the file path.';
                yield* showLoggedMessage(CHANNEL, message);
                return;
              }

              const stats = parseTeXCountStats(output);

              yield* quickPick(stats, {
                placeHolder: 'TeXCount Results (press Esc to dismiss)',
                canPickMany: false,
              });
            }),
        );
      }),
  );
}
