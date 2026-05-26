import { defineCommand } from 'citty';

import { toErrorMessage } from '@common/errors/errorMessage';
import {
  loadMemoryItems,
  loadMemoryPreview,
} from '@tools/memory/memoryFileSystem';
import { toDisplayPath } from '@tools/memory/memoryUtils';

import { CliExitCode } from '../runtime/exitCodes';
import { initReadonlyCliPlatform } from '../runtime/initPlatform';
import { writeTextStderr, writeTextStdout } from '../runtime/logSinks';
import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  resolveCliMemoryStoragePath,
} from '../runtime/memory';

import { contextFromArgs } from './_helpers/context';
import { setExitCode } from './_helpers/exitCode';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

async function runMemoryList(context: CliContext): Promise<number> {
  await initReadonlyCliPlatform(context);
  // Pass the full list to `formatCliMemoryList`; it owns truncation (the
  // `Memories (N):` total and `... N more` overflow line) and JSON/NDJSON
  // consumers should see every memory, not a capped slice.
  const items = await loadMemoryItems();

  emitCliResult(context, {
    json: items,
    ndjson: items.map((memory) => ({ kind: 'memory', memory })),
    text: formatCliMemoryList(items),
  });
  return CliExitCode.Success;
}

async function runMemoryShow(
  context: CliContext,
  inputPath: string,
): Promise<number> {
  await initReadonlyCliPlatform(context);

  if (context.outputFormat === 'text') {
    writeTextStdout(await formatCliMemoryPreview(inputPath));
    return CliExitCode.Success;
  }

  const storagePath = resolveCliMemoryStoragePath(inputPath);
  const preview = await loadMemoryPreview(storagePath);
  const record = {
    path: toDisplayPath(storagePath),
    lineCount: preview.lineCount,
    preview: preview.preview,
  };
  emitCliResult(context, {
    json: record,
    ndjson: { kind: 'memory-detail', ...record },
    text: '',
  });
  return CliExitCode.Success;
}

const memoryListCommand = defineCommand({
  meta: { name: 'list', description: 'List stored memories' },
  args: { ...GLOBAL_ARGS },
  async run(ctx) {
    const context = await contextFromArgs(ctx.args);
    try {
      setExitCode(await runMemoryList(context));
    } catch (error) {
      writeTextStderr(toErrorMessage(error));
      setExitCode(CliExitCode.AgentError);
    }
  },
});

const memoryShowCommand = defineCommand({
  meta: { name: 'show', description: 'Show one stored memory' },
  args: {
    ...GLOBAL_ARGS,
    path: {
      type: 'positional',
      required: true,
      description:
        'Memory path from `texra memory list` (e.g. memories/<file>)',
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
