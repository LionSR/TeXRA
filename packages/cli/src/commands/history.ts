import { defineCommand } from 'citty';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { formatChatAsMarkdown } from '@agent/export/chatExportFormatter';
import { formatChatAsHtml } from '@agent/export/htmlExport/htmlFormatter';
import type { ChatExportInput } from '@agent/export/schemas';
import { getExecutionStore } from '@agent/storage';
import { type ExecutionId } from '@shared/schemas';

import { CliExitCode } from '../runtime/exitCodes';
import {
  cliHistoryNdjsonRecords,
  deleteCliHistory,
  formatCliHistoryDetailsText,
  formatCliHistoryNotFoundText,
  formatCliHistoryText,
  listCliHistoryEntries,
  parseCliHistoryId,
  preflightCliHistoryDeleteAll,
  readCliHistoryDetails,
  type CliHistoryDeleteResult,
} from '../runtime/history';
import { initLocalCliPlatform } from '../runtime/initPlatform';
import { writeErrorStderr, writeTextStderr } from '../runtime/logSinks';

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

function storedExecutionsNoun(count: number): string {
  return count === 1 ? 'stored execution' : 'stored executions';
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
 * Mirrors the extension's ChatExportController.buildExportInput so the CLI
 * and the extension render the same conversation identically; the HTML path
 * reuses the Lit-SSR chat exporter (headless rendering engine for traces).
 */
async function runHistoryExport(
  context: CliContext,
  id: ExecutionId,
  format: 'html' | 'md',
  options: { assetsHref?: string } = {},
): Promise<number> {
  await initLocalCliPlatform(context);
  const store = getExecutionStore(id);
  const [rawConfig, conversation, meta] = await Promise.all([
    store.readConfig(),
    store.readConversation(),
    store.readMeta(),
  ]);
  if (!rawConfig || !conversation) {
    writeTextStderr(
      !rawConfig
        ? `No stored config for execution ${id}.`
        : `No stored conversation for execution ${id}.`,
    );
    return CliExitCode.Usage;
  }
  const config = AgentConfigSchema.parse(rawConfig);
  const exportInput: ChatExportInput = {
    timestamp: meta?.timestamp ?? new Date().toISOString(),
    description: meta?.description,
    config: {
      agent: config.agent,
      model: config.model,
      instruction: config.instruction,
      inputFiles: config.inputFiles,
      mediaFiles: config.mediaFiles,
      contextFiles: config.contextFiles,
      outputFiles: config.outputFiles,
    },
    messages: conversation,
  };
  const content =
    format === 'html'
      ? formatChatAsHtml(exportInput, { assetsHref: options.assetsHref })
      : formatChatAsMarkdown(exportInput);
  process.stdout.write(content);
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
        `Refusing to delete ${preflight.count} ${storedExecutionsNoun(
          preflight.count,
        )}. Re-run with --yes to confirm.`,
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

  let text: string;
  if (result.deleted === 'all') {
    text = `Deleted ${result.count} ${storedExecutionsNoun(result.count)}.`;
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
        'Export the stored conversation to stdout as a standalone html or md document',
    },
    assets: {
      type: 'string',
      valueHint: 'href',
      description: 'Assets href for --export html (defaults to ./assets)',
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
        writeTextStderr(
          `Invalid export format: ${exportFormat} (use html or md)`,
        );
        return Promise.resolve(CliExitCode.Usage);
      }
      return runHistoryExport(context, id, exportFormat, {
        assetsHref: optString(ctx.args.assets),
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
