import { Effect, Option, absurd } from 'effect';
import { Argument, Command, Flag } from 'effect/cli';

import { type RunId } from '@texra-ai/harness/schemas';
import { formatChatAsMarkdown } from '@texra/agent/export/chatExport/markdownSpec';
import { traceHtml } from '@texra/agent/export/standaloneTraceHtml';

import { CliExitCode } from '../runtime/platform/exitCodes';
import {
  deleteCliHistory,
  formatCliHistoryDetailsText,
  formatCliHistoryNotFoundText,
  formatCliHistoryText,
  listCliHistoryEntries,
  parseCliHistoryId,
  readCliHistoryDetails,
  readCliHistoryExportInput,
  type CliHistoryDeleteResult,
} from '../runtime/history';
import { formatCliHistoryDeletionSummary } from '../runtime/historyLabels';
import { cliPlatform } from '../runtime/platform/initPlatform';
import {
  cliErrorMessage,
  writeErrorStderr,
  writeRawStdout,
  writeTextStderr,
} from '../runtime/platform/logSinks';

import { cliCommand } from './_helpers/cliCommand';
import { boolFlag } from './_helpers/flags';
import {
  cliResult,
  emitCliResult,
  emitPagedCliResult,
} from './_helpers/output';
import { CliUsageError, type CliContext } from '../runtime/platform/cliContext';

const runHistoryList = Effect.fn('runHistoryList')(function* (options: {
  limit?: number;
}) {
  const stores = yield* cliPlatform;
  const entries = yield* listCliHistoryEntries(yield* stores.runSession);
  const visibleEntries =
    options.limit !== undefined ? entries.slice(0, options.limit) : entries;

  yield* emitPagedCliResult(
    cliResult(
      'history-entry',
      visibleEntries,
      visibleEntries.length
        ? formatCliHistoryText(visibleEntries)
        : 'No history yet. Runs appear here after you start an agent.',
    ),
  );
});

const runHistoryShow = Effect.fn('runHistoryShow')(function* (
  context: CliContext,
  id: RunId,
  options: { full?: boolean },
) {
  const stores = yield* cliPlatform;
  const details = yield* readCliHistoryDetails(
    yield* stores.runSession,
    stores.roots.storage,
    id,
    { includeFullConversation: options.full === true },
  );
  if (!details) {
    writeTextStderr(formatCliHistoryNotFoundText(id, context.cwd));
    return CliExitCode.Usage;
  }

  yield* emitCliResult(
    cliResult('history-detail', details, formatCliHistoryDetailsText(details)),
  );
});

/**
 * Export a stored conversation to stdout as a standalone document.
 *
 * `md` uses the same input loader and formatter as the progress view, so
 * the CLI and the GUI render the same conversation identically.
 *
 * `html` assembles the run's trace (`assembleTrace`, shared with the
 * progress-view "Export transcript" button) and embeds it into the
 * trace-viewer — the same faithful Progress View replay, not a separate
 * hand-written exporter. It writes one self-contained page to stdout (JS/CSS/
 * fonts all inlined, so `> out.html` opens correctly via `file://` with no
 * server).
 */
const runHistoryExport = Effect.fn('runHistoryExport')(function* (
  context: CliContext,
  id: RunId,
  format: 'html' | 'md',
) {
  const stores = yield* cliPlatform;
  if (format === 'md') {
    const exportResult = yield* readCliHistoryExportInput(
      yield* stores.runSession,
      id,
    );
    if (exportResult.status === 'not_found') {
      writeTextStderr(formatCliHistoryNotFoundText(id, context.cwd));
      return CliExitCode.Usage;
    }
    if (exportResult.status === 'incomplete') {
      writeTextStderr(
        `Run ${id} exists but has nothing to export yet (no stored ` +
          `config and/or conversation). Run \`texra history show ${id}\` to see what is available.`,
      );
      return CliExitCode.Usage;
    }
    writeRawStdout(formatChatAsMarkdown(exportResult.exportInput));
    return;
  }

  const page = yield* traceHtml(
    yield* stores.runSession,
    id,
    context.resourcesPath,
  ).pipe(
    Effect.catchTags({
      TraceUnavailable: ({ status }) => {
        switch (status) {
          case 'no_record':
            writeTextStderr(formatCliHistoryNotFoundText(id, context.cwd));
            break;
          case 'no_rows':
            writeTextStderr(
              `Run ${id} exists but has no transcript to replay (it produced no output).`,
            );
            break;
          default:
            absurd(status);
        }
        return Effect.succeed(null);
      },
      TraceViewerMissing: () => {
        writeTextStderr(
          'The bundled trace-viewer standalone template was not found in this ' +
            'CLI install. Rebuild the CLI (`npm run texra-local:build`) so ' +
            'packages/trace-viewer builds.',
        );
        return Effect.succeed(null);
      },
      // Any other failure to read the bundle (EACCES, a transient I/O
      // error) is not "rebuild the CLI": it names the real cause.
      PlatformError: (error) =>
        Effect.fail(
          new CliUsageError({
            message: `history export: cannot read the trace-viewer bundle: ${cliErrorMessage(error)}`,
          }),
        ),
    }),
  );
  if (page === null) return CliExitCode.Usage;
  writeRawStdout(page.html);
});

const runHistoryDelete = Effect.fn('runHistoryDelete')(function* (
  context: CliContext,
  options: { target: RunId | 'all'; yes: boolean },
) {
  const stores = yield* cliPlatform;

  // `--all` is destructive and unrecoverable. Refuse it unless the caller
  // also passes `--yes`, and quote the count so the stakes are explicit.
  if (options.target === 'all' && !options.yes) {
    writeTextStderr(
      `Refusing to delete every stored task in ${context.cwd}. Re-run with --yes to confirm.`,
    );
    return CliExitCode.Usage;
  }

  // A deletion that fails reports its error and exits Usage, the way
  // every other refusal on this command does; a defect reaches the crash
  // handler.
  const result: CliHistoryDeleteResult | null = yield* deleteCliHistory(
    yield* stores.runSession,
    options.target,
  ).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        writeErrorStderr(error);
        return null;
      }),
    ),
  );
  if (result === null) return CliExitCode.Usage;

  // JSON/NDJSON consumers get the structured result (including
  // `found:false`) so scripts can branch on it; text consumers get a stderr
  // error + Usage exit because the human-readable path can't render "not
  // found" usefully.
  if (result.deleted === 'one' && context.outputFormat === 'text') {
    if (result.status === 'not-found') {
      writeTextStderr(formatCliHistoryNotFoundText(result.id, context.cwd));
      return CliExitCode.Usage;
    }
    if (result.status === 'active') {
      writeTextStderr(
        `Task ${result.id} is active in TeXRA and was not deleted.`,
      );
      return CliExitCode.Usage;
    }
  }

  let text: string;
  if (result.deleted === 'all') {
    text = formatCliHistoryDeletionSummary({
      deleted: result.count,
      active: result.active.length,
      failed: result.failed.length,
    });
  } else if (result.status === 'deleted') {
    text = `Deleted task ${result.id}.`;
  } else {
    text = '';
  }

  yield* emitCliResult(cliResult('history-delete', result, text));
  return result.deleted === 'all' && result.failed.length > 0
    ? CliExitCode.Usage
    : CliExitCode.Success;
});

const TASK_ID_DESCRIPTION = 'Task id from `texra history list`';

// `texra history` on its own is `texra history list`: the group takes the
// listing's flags and runs it.
const historyList = {
  config: {
    limit: Flag.Int('limit').pipe(
      Flag.filter(
        (count) => count >= 1,
        (count) => `Expected at least 1 task, got ${count}`,
      ),
      Flag.withAlias('n'),
      Flag.withMetavar('count'),
      Flag.withDescription('Show at most this many tasks'),
      Flag.optional,
    ),
  },
  run: (_: CliContext, input: { readonly limit: Option.Option<number> }) =>
    runHistoryList({ limit: Option.getOrUndefined(input.limit) }),
};

const historyShowCommand = cliCommand('show', {
  description: 'Show one stored task',
  config: {
    id: Argument.String('id').pipe(
      Argument.withDescription(TASK_ID_DESCRIPTION),
    ),
    full: boolFlag(
      'full',
      'Show the full stored conversation instead of only the final preview',
    ),
    export: Flag.Literals('export', ['html', 'md']).pipe(
      Flag.withDescription(
        'Export the run to stdout: html is a self-contained trace-viewer replay, md is the conversation as Markdown',
      ),
      Flag.optional,
    ),
  },
  run: (context, input) => {
    const id = parseCliHistoryId(input.id);
    if (!id) {
      throw new CliUsageError({ message: `Invalid task id: ${input.id}` });
    }
    const exportFormat = Option.getOrUndefined(input.export);
    if (exportFormat !== undefined)
      return runHistoryExport(context, id, exportFormat);
    return runHistoryShow(context, id, { full: input.full });
  },
});

const historyDeleteCommand = cliCommand('delete', {
  description: 'Delete stored tasks',
  config: {
    id: Argument.String('id').pipe(
      Argument.withDescription(TASK_ID_DESCRIPTION),
      Argument.optional,
    ),
    all: boolFlag('all', 'Delete all stored tasks (requires --yes to confirm)'),
    yes: boolFlag(
      'yes',
      'Confirm destructive deletes (required with --all; ignored otherwise)',
    ).pipe(Flag.withAlias('y')),
  },
  run: (context, input) => {
    const rawId = Option.getOrUndefined(input.id);
    const id = rawId ? parseCliHistoryId(rawId) : undefined;
    if (rawId && !id) {
      throw new CliUsageError({ message: `Invalid task id: ${rawId}` });
    }
    const target = input.all ? 'all' : id;
    if (!target) {
      throw new CliUsageError({ message: 'Expected a task id, or --all.' });
    }
    return runHistoryDelete(context, { target, yes: input.yes });
  },
});

export const historyCommand = cliCommand('history', {
  description: 'Inspect stored tasks',
  ...historyList,
}).pipe(
  Command.withSubcommands([
    cliCommand('list', { description: 'List stored tasks', ...historyList }),
    historyShowCommand,
    historyDeleteCommand,
  ]),
);
