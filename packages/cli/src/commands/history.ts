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
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS, optString } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

async function runHistoryList(context: CliContext): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  const entries = await listCliHistoryEntries();

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(entries, null, 2));
    return CliExitCode.Success;
  }

  if (context.outputFormat === 'ndjson') {
    for (const record of cliHistoryNdjsonRecords(entries)) {
      writeNdjsonStdout(record);
    }
    return CliExitCode.Success;
  }

  writeTextStdout(
    entries.length
      ? formatCliHistoryText(entries)
      : 'No execution history found.',
  );
  return CliExitCode.Success;
}

async function runHistoryShow(
  context: CliContext,
  id: ExecutionId,
): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  const details = await readCliHistoryDetails(id);
  if (!details) {
    writeTextStderr(`Execution not found: ${id}`);
    return CliExitCode.Usage;
  }

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(details, null, 2));
  } else if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'history-detail',
      ts: new Date().toISOString(),
      detail: details,
    });
  } else {
    writeTextStdout(formatCliHistoryDetailsText(details));
  }
  return CliExitCode.Success;
}

async function runHistoryDelete(
  context: CliContext,
  options: { id?: ExecutionId; all: boolean; yes: boolean },
): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });

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

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(result, null, 2));
  } else if (context.outputFormat === 'ndjson') {
    writeNdjsonStdout({
      kind: 'history-delete',
      ts: new Date().toISOString(),
      result,
    });
  } else if (result.deleted === 'all') {
    const noun = result.count === 1 ? 'stored execution' : 'stored executions';
    writeTextStdout(`Deleted ${result.count} ${noun}.`);
  } else if (result.found) {
    writeTextStdout(`Deleted execution ${result.id}.`);
  } else {
    writeTextStderr(`Execution not found: ${result.id}`);
    return CliExitCode.Usage;
  }
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
