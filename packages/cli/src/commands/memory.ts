import { defineCommand } from 'citty';

import { toErrorMessage } from '@common/errors/errorMessage';
import {
  loadMemoryItems,
  loadMemoryPreview,
} from '@tools/memory/memoryFileSystem';
import { toDisplayPath } from '@tools/memory/memoryUtils';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  writeNdjsonStdout,
  writeTextStderr,
  writeTextStdout,
} from '../runtime/logSinks';
import {
  CLI_MEMORY_LIST_LIMIT,
  formatCliMemoryList,
  formatCliMemoryPreview,
  resolveCliMemoryStoragePath,
} from '../runtime/memory';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import type { CliContext } from '../runtime/cliContext';

async function runMemoryList(context: CliContext): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });
  const items = (await loadMemoryItems()).slice(0, CLI_MEMORY_LIST_LIMIT);

  if (context.outputFormat === 'json') {
    writeTextStdout(JSON.stringify(items, null, 2));
    return CliExitCode.Success;
  }
  if (context.outputFormat === 'ndjson') {
    const ts = new Date().toISOString();
    for (const memory of items) {
      writeNdjsonStdout({ kind: 'memory', ts, memory });
    }
    return CliExitCode.Success;
  }
  writeTextStdout(formatCliMemoryList(items));
  return CliExitCode.Success;
}

async function runMemoryShow(
  context: CliContext,
  inputPath: string,
): Promise<number> {
  await initCliPlatform({
    ...context,
    quietLogs: true,
    skipIncludedModelAccess: true,
  });

  if (context.outputFormat === 'json' || context.outputFormat === 'ndjson') {
    const storagePath = resolveCliMemoryStoragePath(inputPath);
    const preview = await loadMemoryPreview(storagePath);
    const record = {
      path: toDisplayPath(storagePath),
      lineCount: preview.lineCount,
      preview: preview.preview,
    };
    if (context.outputFormat === 'json') {
      writeTextStdout(JSON.stringify(record, null, 2));
    } else {
      writeNdjsonStdout({
        kind: 'memory-detail',
        ts: new Date().toISOString(),
        ...record,
      });
    }
    return CliExitCode.Success;
  }

  writeTextStdout(await formatCliMemoryPreview(inputPath));
  return CliExitCode.Success;
}

const memoryListCommand = defineCommand({
  meta: { name: 'list', description: 'List stored memories' },
  args: { ...GLOBAL_ARGS },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    setExitCode(await runMemoryList(context));
  },
});

const memoryShowCommand = defineCommand({
  meta: { name: 'show', description: 'Show one stored memory' },
  args: {
    ...GLOBAL_ARGS,
    path: {
      type: 'positional',
      required: true,
      description: 'Memory path from `texra memory list` (e.g. memories/<file>)',
    },
  },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    try {
      setExitCode(await runMemoryShow(context, ctx.args.path));
    } catch (error) {
      writeTextStderr(toErrorMessage(error));
      setExitCode(CliExitCode.Usage);
    }
  },
});

export const memoryCommand = defineCommand({
  meta: { name: 'memory', description: 'Inspect stored memories' },
  subCommands: { list: memoryListCommand, show: memoryShowCommand },
});
