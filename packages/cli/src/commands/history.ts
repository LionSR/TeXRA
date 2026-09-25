import { defineCommand } from 'citty';
import { Cause, Effect } from 'effect';

import { formatChatAsMarkdown } from '@agent/export';
import { listRuns } from '@agent/storage';
import { type RunId } from '@shared/schemas';
import { assembleTrace, injectStandaloneTrace } from '@transcript';
import { formatCliHistoryDeletionSummary } from '@ui/copy/runHistory';
import { assertNever } from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

import { CliExitCode } from '../runtime/exitCodes';
import {
  cliHistoryDetailNdjsonRecord,
  cliHistoryNdjsonRecords,
  deleteCliHistory,
  formatCliHistoryDetailsText,
  formatCliHistoryNotFoundText,
  formatCliHistoryText,
  formatInvalidExportFormatText,
  listCliHistoryEntries,
  parseCliHistoryId,
  readCliHistoryDetails,
  readCliHistoryExportInput,
  readCliHistoryStandaloneTemplate,
  type CliHistoryDeleteResult,
} from '../runtime/history';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeErrorStderr,
  writeRawStdout,
  writeTextStderr,
} from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult, emitPagedCliResult } from './_helpers/output';
import { CliUsageError, type CliContext } from '../runtime/cliContext';

export function parseHistoryListLimit(
  value: string | undefined,
): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

function runHistoryList(context: CliContext, options: { limit?: number }) {
  // The init and the history read it feeds are one program, run on the
  // process runtime the command entry installs.
  return Effect.gen(function* () {
    const stores = yield* initCliPlatform({ ...context, quietLogs: true });
    const entries = yield* listCliHistoryEntries(stores.session);
    const visibleEntries =
      options.limit !== undefined ? entries.slice(0, options.limit) : entries;

    yield* emitPagedCliResult(context, {
      json: visibleEntries,
      ndjson: cliHistoryNdjsonRecords(visibleEntries),
      text: visibleEntries.length
        ? formatCliHistoryText(visibleEntries)
        : 'No history yet. Runs appear here after you start an agent.',
    });
    return CliExitCode.Success;
  });
}

function runHistoryShow(
  context: CliContext,
  id: RunId,
  options: { full?: boolean },
) {
  return Effect.gen(function* () {
    const stores = yield* initCliPlatform({ ...context, quietLogs: true });
    const details = yield* readCliHistoryDetails(stores.session, id, {
      includeFullConversation: options.full === true,
    });
    if (!details) {
      writeTextStderr(formatCliHistoryNotFoundText(id, context.cwd));
      return CliExitCode.Usage;
    }

    emitCliResult(context, {
      json: details,
      ndjson: cliHistoryDetailNdjsonRecord(details),
      text: formatCliHistoryDetailsText(details),
    });
    return CliExitCode.Success;
  });
}

/**
 * Export a stored conversation to stdout as a standalone document.
 *
 * `md` mirrors the progress-view ChatExportController.buildExportInput so the
 * CLI and the GUI render the same conversation identically.
 *
 * `html` assembles the run's trace (`assembleTrace`, shared with the
 * progress-view "Export transcript" button) and embeds it into the
 * trace-viewer — the same faithful Progress View replay, not a separate
 * hand-written exporter. It writes one self-contained page to stdout (JS/CSS/
 * fonts all inlined, so `> out.html` opens correctly via `file://` with no
 * server).
 */
export function runHistoryExport(
  context: CliContext,
  id: RunId,
  format: 'html' | 'md',
) {
  return Effect.gen(function* () {
    const stores = yield* initCliPlatform({ ...context, quietLogs: true });
    if (format === 'md') {
      const exportResult = yield* readCliHistoryExportInput(stores.session, id);
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
      return CliExitCode.Success;
    }

    const session = yield* stores.session;
    const traceResult = yield* assembleTrace(id, session);
    if (traceResult.status !== 'ok') {
      switch (traceResult.status) {
        case 'config_missing':
          writeTextStderr(formatCliHistoryNotFoundText(id, context.cwd));
          break;
        case 'streamLogs_missing':
          writeTextStderr(
            `Run ${id} exists but has no replayable run-root transcript ` +
              '(it may predate transcript persistence, the run may have produced ' +
              'no output, or only proven child transcripts may remain).',
          );
          break;
        default:
          assertNever(traceResult, 'Unhandled trace assembly result');
      }
      return CliExitCode.Usage;
    }
    const template = yield* readCliHistoryStandaloneTemplate(
      context.resourcesPath,
    );
    if (template === null) {
      writeTextStderr(
        'The bundled trace-viewer standalone template was not found in this ' +
          'CLI install. Rebuild the CLI (`npm run texra-local:build`) so ' +
          'packages/trace-viewer builds.',
      );
      return CliExitCode.Usage;
    }
    writeRawStdout(injectStandaloneTrace(template, traceResult.trace));
    return CliExitCode.Success;
  });
}

function runHistoryDelete(
  context: CliContext,
  options: { id?: RunId; all: boolean; yes: boolean },
) {
  return Effect.gen(function* () {
    const stores = yield* initCliPlatform({ ...context, quietLogs: true });
    // Both deletion paths read the same session: opened once here, in the
    // one program the run arm runs.
    const session = yield* stores.session;

    // `--all` is destructive and unrecoverable. Refuse it unless the caller
    // also passes `--yes`, and quote the count so the stakes are explicit.
    if (options.all && !options.yes) {
      // Unlike list, a full wipe intentionally counts (and later clears)
      // every stored run, including `isUserVisibleRun`-hidden
      // process-bookkeeping entries and agent-spawned child runs — don't add
      // the visibility filter here.
      const count = (yield* listRuns(session)).length;
      writeTextStderr(
        `Refusing to delete ${formatResultCount(count, 'stored run')}. Re-run with --yes to confirm.`,
      );
      return CliExitCode.Usage;
    }

    // A deletion that fails or dies reports its cause and exits Usage, the
    // way every other refusal on this command does.
    const result: CliHistoryDeleteResult | null = yield* deleteCliHistory(
      session,
      options,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          writeErrorStderr(Cause.squash(cause));
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
          `Run ${result.id} is active in TeXRA and was not deleted.`,
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
      text = `Deleted run ${result.id}.`;
    } else {
      text = '';
    }

    emitCliResult(context, {
      json: result,
      ndjson: { kind: 'history-delete', result },
      text,
    });
    return result.deleted === 'all' && result.failed.length > 0
      ? CliExitCode.Usage
      : CliExitCode.Success;
  });
}

const historyListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List stored runs' },
  args: {
    ...GLOBAL_ARGS,
    limit: {
      type: 'string',
      alias: 'n',
      valueHint: 'count',
      description: 'Show at most this many runs',
    },
  },
  // The argument parses are the builder's, above the program: a refusal is
  // `CliUsageError`, which `runCli` reports as the same stderr line and exit
  // 2 the program would have returned — and refuses before `defineCliCommand`
  // installs a process runtime this command would never bring a platform up
  // to dispose.
  run: (context, ctx) => {
    const limitValue = optString(ctx.args.limit);
    const limit = parseHistoryListLimit(limitValue);
    if (limitValue !== undefined && limit === undefined) {
      throw new CliUsageError(`Invalid history limit: ${limitValue}`);
    }
    return runHistoryList(context, { limit });
  },
});

const historyShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show one stored run' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Run id from `texra history list`',
    },
    full: {
      type: 'boolean',
      description:
        'Show the full stored conversation instead of only the final preview',
    },
    export: {
      type: 'string',
      valueHint: 'html|md',
      description:
        'Export the run to stdout: html is a self-contained trace-viewer replay, md is the conversation as Markdown',
    },
  },
  run: (context, ctx) => {
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      throw new CliUsageError(`Invalid run id: ${ctx.args.id}`);
    }
    const exportFormat = optString(ctx.args.export);
    if (exportFormat !== undefined) {
      if (exportFormat !== 'html' && exportFormat !== 'md') {
        throw new CliUsageError(formatInvalidExportFormatText(exportFormat));
      }
      return runHistoryExport(context, id, exportFormat);
    }
    return runHistoryShow(context, id, { full: ctx.args.full === true });
  },
});

const historyDeleteCommand = defineCliCommand({
  meta: { name: 'delete', description: 'Delete stored runs' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: false,
      description: 'Run id from `texra history list`',
    },
    all: {
      type: 'boolean',
      description: 'Delete all stored runs (requires --yes to confirm)',
    },
    yes: {
      type: 'boolean',
      alias: 'y',
      description:
        'Confirm destructive deletes (required with --all; ignored otherwise)',
    },
  },
  run: (context, ctx) => {
    const rawId = optString(ctx.args.id);
    const id = rawId ? parseCliHistoryId(rawId) : undefined;
    if (rawId && !id) {
      throw new CliUsageError(`Invalid run id: ${rawId}`);
    }
    return runHistoryDelete(context, {
      id,
      all: ctx.args.all === true,
      yes: ctx.args.yes === true,
    });
  },
});

export const historyCommand = defineCommand({
  meta: { name: 'history', description: 'Inspect stored runs' },
  args: {
    ...GLOBAL_ARGS,
  },
  // Bare `texra history` is the obvious history listing command. Keep it as
  // an alias of `history list` so global flags continue to work at the parent.
  default: 'list',
  subCommands: {
    list: historyListCommand,
    show: historyShowCommand,
    delete: historyDeleteCommand,
  },
});
