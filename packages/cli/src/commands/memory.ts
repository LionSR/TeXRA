import { defineCommand } from 'citty';
import { Effect } from 'effect';

import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

import { CliExitCode } from '../runtime/exitCodes';
import { installCliProcessRuntime } from '../runtime/cliProcessRuntime';
import {
  initCliPlatform,
  type CliPlatformServices,
} from '../runtime/initPlatform';
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

/**
 * The process roots this command's init installed, which the memory reads run
 * their storage view over. Absent only when another root installed the
 * platform first, and then there is no root here to name.
 */
function memoryRoots(
  services: CliPlatformServices,
): NonNullable<CliPlatformServices['roots']> {
  if (!services.roots) {
    throw new Error(
      'texra memory needs the workspace roots its platform init installs.',
    );
  }
  return services.roots;
}

async function runMemoryList(context: CliContext): Promise<number> {
  // The command's one run, on the process runtime this entry installs or
  // joins: the init and the read it feeds are one program on it.
  const runtime = await installCliProcessRuntime(context.storageRoot);
  return runtime.runPromise(
    Effect.gen(function* () {
      const services = yield* initCliPlatform({ ...context, quietLogs: true });
      // Pass the full list to `formatCliMemoryList`; it owns truncation (the
      // `Memories (N):` total and `... N more` overflow line) and JSON/NDJSON
      // consumers should see every memory, not a capped slice.
      const items = yield* runCliMemory(
        memoryRoots(services),
        loadMemoryItems(),
      );

      emitCliResult(context, {
        json: items,
        ndjson: items.map((memory) => ({ kind: 'memory', memory })),
        text: formatCliMemoryList(items),
      });
      return CliExitCode.Success;
    }),
  );
}

async function runMemoryShow(
  context: CliContext,
  inputPath: string,
): Promise<number> {
  const runtime = await installCliProcessRuntime(context.storageRoot);
  return runtime.runPromise(
    Effect.gen(function* () {
      const services = yield* initCliPlatform({ ...context, quietLogs: true });
      const record = yield* runCliMemory(
        memoryRoots(services),
        loadCliMemoryDetail(inputPath),
      );
      emitCliResult(context, {
        json: record,
        ndjson: { kind: 'memory-detail', ...record },
        text: formatCliMemoryPreview(record),
      });
      return CliExitCode.Success;
    }),
  );
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
