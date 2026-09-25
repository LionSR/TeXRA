// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { runGuardedLatexCommand } from '@frontend/editor/activeFileGuards';
import {
  showLoggedInfoMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { withVSCodeProgress } from '@frontend/ui/progress';
import {
  getTeXCount,
  parseTeXCountStats,
  type TexcountMode,
} from '@latex/texcount';
import { LATEX_COMMANDS_CHANNEL as CHANNEL } from '@latex/latexLogging';
import { resolveLatexFormatter } from '@latex/formatter/texFormatter';
import { buildLatexdiffAwareFixInstruction } from '@latex/latexdiff/diffFileNameManager';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessServices } from '@platform/processRuntime';
import { AgentCategory } from '@shared/schemas';

export function handleFixCompilation(
  session: SessionHandle,
): Effect.Effect<void, Error, ProcessServices> {
  return runGuardedLatexCommand(
    session,
    {
      channel: CHANNEL,
      action: 'fix compilation',
      saveDocument: true,
      errorMessage: 'Error launching LaTeX compilation fixer',
    },
    ({ editor, relativePath }) =>
      Effect.gen(function* () {
        yield* Effect.logInfo(
          `Launching tool-use agent to fix compilation for: ${relativePath}`,
        ).pipe(withLogChannel(CHANNEL));

        const instruction = yield* buildLatexdiffAwareFixInstruction(
          `Fix the LaTeX compilation errors in ${relativePath}.`,
          editor.document.fileName,
          session.roots.workspace,
        );

        yield* Effect.promise(() =>
          vscode.commands.executeCommand('texra.execute', {
            config: {
              agent: 'latexFixer',
              // latexFixer is a tool-use agent; without this the config
              // category prefaults to workflow and resolveAgentForLaunch
              // can't find it.
              agentCategory: AgentCategory.ToolUse,
              instruction,
            },
            // This is a "run latexFixer" command, so prefer the helper model.
            preferHelperModel: true,
          }),
        );
      }),
  );
}

export function handleIndentCurrentTeX(
  session: SessionHandle,
): Effect.Effect<void, Error, ProcessServices> {
  return runGuardedLatexCommand(
    session,
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
        const formatter = yield* resolveLatexFormatter(session.roots);
        if (!formatter) {
          yield* showLoggedInfoMessage(
            CHANNEL,
            'LaTeX formatter is disabled; no file was indented',
          );
          return;
        }

        const success = yield* formatter.run(
          relativePath,
          session.roots.workspace,
          formatter.configPath,
          session.roots,
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
  session: SessionHandle,
): Effect.Effect<void, Error, ProcessServices> {
  return runGuardedLatexCommand(
    session,
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

        const countingMode = yield* Effect.promise(() =>
          vscode.window.showQuickPick<
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
          ),
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
                session.roots.workspace,
                relativePath,
                {
                  mode: countingMode.value,
                  channel: CHANNEL,
                  settings: session.roots,
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

              yield* Effect.promise(() =>
                vscode.window.showQuickPick(stats, {
                  placeHolder: 'TeXCount Results (press Esc to dismiss)',
                  canPickMany: false,
                }),
              );
            }),
        );
      }),
  );
}
