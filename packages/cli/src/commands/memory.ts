import { defineCommand } from 'citty';

import {
  loadMemoryItems,
  loadMemoryPreview,
} from '@tools/memory/memoryFileSystem';
import { toDisplayPath } from '@tools/memory/memoryUtils';

import { CliExitCode } from '../runtime/exitCodes';
import { initLocalCliPlatform } from '../runtime/initPlatform';
import { writeTextStdout } from '../runtime/logSinks';
import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  cliMemoryStoragePathFromInput,
} from '../runtime/memory';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

async function runMemoryList(context: CliContext): Promise<number> {
  await initLocalCliPlatform(context);
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
  await initLocalCliPlatform(context);

  if (context.outputFormat === 'text') {
    writeTextStdout(await formatCliMemoryPreview(inputPath));
    return CliExitCode.Success;
  }

  const storagePath = cliMemoryStoragePathFromInput(inputPath);
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

const memoryListCommand = defineCliCommand({
  meta: { name: 'list', description: 'List stored memories' },
  args: { ...GLOBAL_ARGS },
  catchExitCode: CliExitCode.AgentError,
  run: runMemoryList,
});

const memoryShowCommand = defineCliCommand({
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
  catchExitCode: CliExitCode.Usage,
  run: (context, ctx) => runMemoryShow(context, ctx.args.path),
});

export const memoryCommand = defineCommand({
  meta: { name: 'memory', description: 'Inspect stored memories' },
  subCommands: { list: memoryListCommand, show: memoryShowCommand },
});
