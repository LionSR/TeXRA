import * as path from 'node:path';

import { defineCommand } from 'citty';

import { assembleTrace, injectStandaloneTrace } from '@transcript';
import { describeHeartbeatOwner } from '@agent/storage';
import { formatChatAsMarkdown } from '@agent/export/chatExportFormatter';
import { type ExecutionId } from '@shared/schemas';
import { formatResultCount } from '@utils/text/stringUtils';

import { CliExitCode } from '../runtime/exitCodes';
import {
  cliHistoryNdjsonRecords,
  deleteCliHistory,
  formatCliHistoryDetailsText,
  formatCliHistoryNotFoundText,
  formatCliHistoryText,
  formatInvalidExportFormatText,
  listCliHistoryEntries,
  parseCliHistoryId,
  preflightCliHistoryDeleteAll,
  readCliHistoryDetails,
  readCliHistoryExportInput,
  readCliHistoryStandaloneTemplate,
  stageCliHistoryTraceViewerAssets,
  type CliHistoryDeleteResult,
} from '../runtime/history';
import { initLocalCliPlatform } from '../runtime/initPlatform';
import {
  writeErrorStderr,
  writeRawStdout,
  writeTextStderr,
} from '../runtime/logSinks';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

export function parseHistoryListLimit(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

async function runHistoryList(
  context: CliContext,
  options: { limit?: number } = {},
): Promise<number> {
  await initLocalCliPlatform(context);
  const entries = await listCliHistoryEntries();
  const visibleEntries =
    options.limit !== undefined ? entries.slice(0, options.limit) : entries;

  emitCliResult(
    context,
    {
      json: visibleEntries,
      ndjson: cliHistoryNdjsonRecords(visibleEntries),
      text: visibleEntries.length
        ? formatCliHistoryText(visibleEntries)
        : 'No execution history found.',
    },
    { paged: true },
  );
  return CliExitCode.Success;
}

async function runHistoryShow(
  context: CliContext,
  id: ExecutionId,
  options: { full?: boolean } = {},
): Promise<number> {
  await initLocalCliPlatform(context);
  const details = await readCliHistoryDetails(id, {
    includeFullConversation: options.full === true,
  });
  if (!details) {
    writeTextStderr(formatCliHistoryNotFoundText(id, context.cwd));
    return CliExitCode.Usage;
  }

  emitCliResult(context, {
    json: details,
    ndjson: { kind: 'history-detail', detail: details },
    text: formatCliHistoryDetailsText(details),
  });
  return CliExitCode.Success;
}

/**
 * Export a stored conversation to stdout as a standalone document.
 *
 * `md` mirrors the extension's ChatExportController.buildExportInput so the
 * CLI and the extension render the same conversation identically.
 *
 * `html` assembles the execution's trace (`assembleTrace`, shared with the
 * extension's "Export as HTML" button) and embeds it into the trace-viewer —
 * the same faithful Progress View replay, not a separate hand-written
 * exporter. Default mode writes one self-contained page to stdout (JS/CSS/
 * fonts all inlined, so it opens correctly via `file://` with no server —
 * `> out.html` works exactly like before). `--assets-dir <dir>` switches to
 * the shared-assets mode for a site publishing many traces: stages the
 * trace-viewer's multi-file bundle into `<dir>` (safe to repeat across many
 * exports pointed at the same directory) and writes just the trace data to
 * stdout, to be redirected next to (or referenced by) that shared bundle's
 * `index.html?trace=<path>`.
 */
export async function runHistoryExport(
  context: CliContext,
  id: ExecutionId,
  format: 'html' | 'md',
  options: { assetsDir?: string } = {},
): Promise<number> {
  await initLocalCliPlatform(context);

  if (format === 'md') {
    const exportResult = await readCliHistoryExportInput(id);
    if (exportResult.status === 'not_found') {
      writeTextStderr(formatCliHistoryNotFoundText(id, context.cwd));
      return CliExitCode.Usage;
    }
    if (exportResult.status === 'incomplete') {
      writeTextStderr(
        `Execution ${id} exists but has nothing to export yet (no stored ` +
          'config and/or conversation). Run `texra history show ' +
          id +
          '` to see what is available.',
      );
      return CliExitCode.Usage;
    }
    writeRawStdout(formatChatAsMarkdown(exportResult.exportInput));
    return CliExitCode.Success;
  }

  const traceResult = await assembleTrace(id);
  if (traceResult.status !== 'ok') {
    if (traceResult.status === 'config_missing') {
      writeTextStderr(formatCliHistoryNotFoundText(id, context.cwd));
    } else {
      writeTextStderr(
        `Execution ${id} exists but has no stored transcript to export (it ` +
          'may predate transcript persistence, or the run never produced ' +
          'any output). Run `texra history show ' +
          id +
          '` to see what is available.',
      );
    }
    return CliExitCode.Usage;
  }
  const { trace } = traceResult;

  if (options.assetsDir) {
    const destDir = path.resolve(context.cwd, options.assetsDir);
    const staged = await stageCliHistoryTraceViewerAssets({
      resourcesPath: context.resourcesPath,
      destDir,
    });
    writeRawStdout(JSON.stringify(trace));
    if (staged === 'missing') {
      writeTextStderr(
        'Note: the bundled trace-viewer assets were not found in this CLI ' +
          'install, so nothing was staged into --assets-dir. Rebuild the ' +
          'CLI (`npm run texra-local:build`) so packages/trace-viewer builds.',
      );
      return CliExitCode.Usage;
    }
    const traceFileName = `${id}.json`;
    const traceFile = path.join(destDir, traceFileName);
    writeTextStderr(
      `Wrote trace JSON for ${id} to stdout. Save the output to ` +
        `${traceFile}, then open ${destDir}/index.html?trace=${traceFileName}.`,
    );
    return CliExitCode.Success;
  }

  const template = await readCliHistoryStandaloneTemplate(
    context.resourcesPath,
  );
  if (template === null) {
    writeTextStderr(
      'The bundled trace-viewer standalone template was not found in this ' +
        'CLI install. Rebuild the CLI (`npm run texra-local:build`) so ' +
        'packages/trace-viewer builds, or pass --assets-dir to use the ' +
        'shared-assets export mode instead.',
    );
    return CliExitCode.Usage;
  }
  writeRawStdout(injectStandaloneTrace(template, trace));
  return CliExitCode.Success;
}

async function runHistoryDelete(
  context: CliContext,
  options: { id?: ExecutionId; all: boolean; yes: boolean },
): Promise<number> {
  await initLocalCliPlatform(context);

  // `--all` is destructive and unrecoverable. Refuse it unless the caller
  // also passes `--yes`, and quote the count so the stakes are explicit.
  let preCountForAll: number | undefined;
  if (options.all) {
    const preflight = await preflightCliHistoryDeleteAll({
      all: true,
      yes: options.yes,
    });
    if (!preflight.proceed) {
      writeTextStderr(
        `Refusing to delete ${formatResultCount(preflight.count, 'stored execution')}. Re-run with --yes to confirm.`,
      );
      return CliExitCode.Usage;
    }
    preCountForAll = preflight.count;
  }

  let result: CliHistoryDeleteResult;
  try {
    result = await deleteCliHistory({ ...options, preCountForAll });
  } catch (error) {
    writeErrorStderr(error);
    return CliExitCode.Usage;
  }

  // JSON/NDJSON consumers get the structured result (including `found:false`)
  // so scripts can branch on it; text consumers get a stderr error + Usage
  // exit because the human-readable path can't render "not found" usefully.
  if (
    result.deleted === 'one' &&
    !result.found &&
    context.outputFormat === 'text'
  ) {
    writeTextStderr(formatCliHistoryNotFoundText(result.id, context.cwd));
    return CliExitCode.Usage;
  }
  // Same split for a refused live deletion: structured consumers branch on
  // `live: true`, text consumers get a stderr error and a failure exit.
  if (
    result.deleted === 'one' &&
    result.live &&
    context.outputFormat === 'text'
  ) {
    writeTextStderr(
      `Cannot delete execution ${result.id}: it is running in ${describeHeartbeatOwner(result.liveHost)}.`,
    );
    return CliExitCode.AgentError;
  }

  let text: string;
  if (result.deleted === 'all') {
    text = `Deleted ${formatResultCount(result.count, 'stored execution')}.`;
    if (result.skippedLive > 0) {
      text += ` Skipped ${formatResultCount(result.skippedLive, 'running execution')}.`;
    }
  } else if (result.live) {
    text = '';
  } else if (result.found) {
    text = `Deleted execution ${result.id}.`;
  } else {
    text = '';
  }

  emitCliResult(context, {
    json: result,
    ndjson: { kind: 'history-delete', result },
    text,
  });
  return CliExitCode.Success;
}

const historyListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List stored executions' },
  args: {
    ...GLOBAL_ARGS,
    limit: {
      type: 'string',
      alias: 'n',
      valueHint: 'count',
      description: 'Show at most this many executions',
    },
  },
  run: (context, ctx) => {
    const limitValue = optString(ctx.args.limit);
    const limit = parseHistoryListLimit(limitValue);
    if (limitValue !== undefined && limit === undefined) {
      writeTextStderr(`Invalid history limit: ${limitValue}`);
      return Promise.resolve(CliExitCode.Usage);
    }
    return runHistoryList(context, { limit });
  },
});

const historyShowCommand = defineCliCommand({
  meta: { name: 'show', description: 'Show one stored execution' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Execution id from `texra history list`',
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
        'Export the execution to stdout: html is a faithful trace-viewer replay (self-contained by default), md is the conversation as Markdown',
    },
    'assets-dir': {
      type: 'string',
      valueHint: 'directory',
      description:
        'Shared trace-viewer bundle location for --export html (for a site publishing many traces); omit for a single self-contained page',
    },
  },
  run: (context, ctx) => {
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      writeTextStderr(`Invalid execution id: ${ctx.args.id}`);
      return Promise.resolve(CliExitCode.Usage);
    }
    const exportFormat = optString(ctx.args.export);
    if (exportFormat !== undefined) {
      if (exportFormat !== 'html' && exportFormat !== 'md') {
        writeTextStderr(formatInvalidExportFormatText(exportFormat));
        return Promise.resolve(CliExitCode.Usage);
      }
      return runHistoryExport(context, id, exportFormat, {
        assetsDir: optString(ctx.args['assets-dir']),
      });
    }
    return runHistoryShow(context, id, { full: ctx.args.full === true });
  },
});

const historyDeleteCommand = defineCliCommand({
  meta: { name: 'delete', description: 'Delete stored executions' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: false,
      description: 'Execution id from `texra history list`',
    },
    all: {
      type: 'boolean',
      description: 'Delete all stored executions (requires --yes to confirm)',
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
      writeTextStderr(`Invalid execution id: ${rawId}`);
      return Promise.resolve(CliExitCode.Usage);
    }
    return runHistoryDelete(context, {
      id,
      all: ctx.args.all === true,
      yes: ctx.args.yes === true,
    });
  },
});

const HISTORY_SUBCOMMANDS = {
  list: historyListCommand,
  show: historyShowCommand,
  delete: historyDeleteCommand,
} as const;

export const HISTORY_SUBCOMMAND_NAMES = Object.keys(HISTORY_SUBCOMMANDS);

export const historyCommand = defineCommand({
  meta: { name: 'history', description: 'Inspect stored executions' },
  args: {
    ...GLOBAL_ARGS,
  },
  // Bare `texra history` is the obvious history listing command. Keep it as
  // an alias of `history list` so global flags continue to work at the parent.
  default: 'list',
  subCommands: HISTORY_SUBCOMMANDS,
});
