import { defineCommand } from 'citty';

import { toErrorMessage } from '@common/errors/errorMessage';
import { type ExecutionId } from '@shared/schemas';

import { CliExitCode } from '../runtime/exitCodes';
import {
  cliHistoryNdjsonRecords,
  deleteCliHistory,
  formatCliHistoryDetailsText,
  formatCliHistoryText,
  listCliHistoryEntries,
  parseCliHistoryId,
  preflightCliHistoryDeleteAll,
  readCliHistoryDetails,
} from '../runtime/history';
import { initReadonlyCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr } from '../runtime/logSinks';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

async function runHistoryList(context: CliContext): Promise<number> {
  await initReadonlyCliPlatform(context);
  const entries = await listCliHistoryEntries();

  emitCliResult(context, {
    json: entries,
    ndjson: cliHistoryNdjsonRecords(entries),
    text: entries.length
      ? formatCliHistoryText(entries)
      : 'No execution history found.',
  });
  return CliExitCode.Success;
}

async function runHistoryShow(
  context: CliContext,
  id: ExecutionId,
): Promise<number> {
  await initReadonlyCliPlatform(context);
  const details = await readCliHistoryDetails(id);
  if (!details) {
    writeTextStderr(`Execution not found: ${id}`);
    return CliExitCode.Usage;
  }

  emitCliResult(context, {
    json: details,
    ndjson: { kind: 'history-detail', detail: details },
    text: formatCliHistoryDetailsText(details),
  });
  return CliExitCode.Success;
}

async function runHistoryDelete(
  context: CliContext,
  options: { id?: ExecutionId; all: boolean; yes: boolean },
): Promise<number> {
  await initReadonlyCliPlatform(context);

  // `--all` is destructive and unrecoverable. Refuse it unless the caller
  // also passes `--yes`, and quote the count so the stakes are explicit.
  let preCountForAll: number | undefined;
  if (options.all) {
    const preflight = await preflightCliHistoryDeleteAll({
      all: true,
      yes: options.yes,
    });
    if (!preflight.proceed) {
      const noun =
        preflight.count === 1 ? 'stored execution' : 'stored executions';
      writeTextStderr(
        `Refusing to delete ${preflight.count} ${noun}. Re-run with --yes to confirm.`,
      );
      return CliExitCode.Usage;
    }
    preCountForAll = preflight.count;
  }

  let result: Awaited<ReturnType<typeof deleteCliHistory>>;
  try {
    result = await deleteCliHistory({ ...options, preCountForAll });
  } catch (error) {
    writeTextStderr(toErrorMessage(error));
    return CliExitCode.Usage;
  }

  if (result.deleted === 'one' && !result.found) {
    writeTextStderr(`Execution not found: ${result.id}`);
    return CliExitCode.Usage;
  }

  const text =
    result.deleted === 'all'
      ? `Deleted ${result.count} ${result.count === 1 ? 'stored execution' : 'stored executions'}.`
      : `Deleted execution ${result.id}.`;

  emitCliResult(context, {
    json: result,
    ndjson: { kind: 'history-delete', result },
    text,
  });
  return CliExitCode.Success;
}

const historyListCommand = defineCommand({
  meta: { name: 'list', description: 'List stored executions' },
  args: {
    ...GLOBAL_ARGS,
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await runHistoryList(context));
  },
});

const historyShowCommand = defineCommand({
  meta: { name: 'show', description: 'Show one stored execution' },
  args: {
    ...GLOBAL_ARGS,
    id: {
      type: 'positional',
      required: true,
      description: 'Execution id from `texra history list`',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const id = parseCliHistoryId(ctx.args.id);
    if (!id) {
      writeTextStderr(`Invalid execution id: ${ctx.args.id}`);
      setExitCode(CliExitCode.Usage);
      return;
    }
    setExitCode(await runHistoryShow(context, id));
  },
});

const historyDeleteCommand = defineCommand({
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
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    const rawId = optString(ctx.args.id);
    const id = rawId ? parseCliHistoryId(rawId) : undefined;
    if (rawId && !id) {
      writeTextStderr(`Invalid execution id: ${rawId}`);
      setExitCode(CliExitCode.Usage);
      return;
    }
    setExitCode(
      await runHistoryDelete(context, {
        id,
        all: ctx.args.all === true,
        yes: ctx.args.yes === true,
      }),
    );
  },
});

export const historyCommand = defineCommand({
  meta: { name: 'history', description: 'Inspect stored executions' },
  subCommands: {
    list: historyListCommand,
    show: historyShowCommand,
    delete: historyDeleteCommand,
  },
});
