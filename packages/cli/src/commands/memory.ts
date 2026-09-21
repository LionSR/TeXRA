import { defineCommand } from 'citty';
import { Effect } from 'effect';

import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

import { CliExitCode } from '../runtime/exitCodes';
import { initCliPlatform } from '../runtime/initPlatform';
import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  loadCliMemoryDetail,
  runCliMemory,
} from '../runtime/memory';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';
import type { CliContext } from '../runtime/cliContext';

function runMemoryList(context: CliContext) {
  // The init and the read it feeds are one program, run on the process
  // runtime the command entry installs.
  return Effect.gen(function* () {
    const services = yield* initCliPlatform({ ...context, quietLogs: true });
    // Pass the full list to `formatCliMemoryList`; it owns truncation (the
    // `Memories (N):` total and `... N more` overflow line) and JSON/NDJSON
    // consumers should see every memory, not a capped slice.
    const items = yield* runCliMemory(services.roots, loadMemoryItems());

    emitCliResult(context, {
      json: items,
      ndjson: items.map((memory) => ({ kind: 'memory', memory })),
      text: formatCliMemoryList(items),
    });
    return CliExitCode.Success;
  });
}

function runMemoryShow(context: CliContext, inputPath: string) {
  return Effect.gen(function* () {
    const services = yield* initCliPlatform({ ...context, quietLogs: true });
    const record = yield* runCliMemory(
      services.roots,
      loadCliMemoryDetail(inputPath),
    );
    emitCliResult(context, {
      json: record,
      ndjson: { kind: 'memory-detail', ...record },
      text: formatCliMemoryPreview(record),
    });
    return CliExitCode.Success;
  });
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
