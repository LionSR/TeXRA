import { defineCommand } from 'citty';
import { Effect } from 'effect';

import { withSessionFs } from '@texra-ai/harness/host';
import { MemoryStore } from '@texra-ai/harness/plugins';

import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  loadCliMemoryDetail,
} from '../runtime/memory';

import { defineCliCommand } from './_helpers/defineCliCommand';
import { GLOBAL_ARGS } from './_helpers/globalArgs';
import { emitCliResult } from './_helpers/output';

const runMemoryList = Effect.fn('runMemoryList')(function* () {
  const services = yield* cliPlatform;
  // Pass the full list to `formatCliMemoryList`; it owns truncation (the
  // `Memories (N):` total and `… N more rows` overflow line) and JSON/NDJSON
  // consumers should see every memory, not a capped slice.
  const items = yield* withSessionFs(services.roots, MemoryStore.list);

  yield* emitCliResult({
    json: items,
    ndjson: items.map((memory) => ({ kind: 'memory', memory })),
    text: formatCliMemoryList(items),
  });
  return CliExitCode.Success;
});

const runMemoryShow = Effect.fn('runMemoryShow')(function* (inputPath: string) {
  const services = yield* cliPlatform;
  const record = yield* withSessionFs(
    services.roots,
    loadCliMemoryDetail(inputPath),
  );
  yield* emitCliResult({
    json: record,
    ndjson: { kind: 'memory-detail', ...record },
    text: formatCliMemoryPreview(record),
  });
  return CliExitCode.Success;
});

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
  run: (_, ctx) => runMemoryShow(ctx.args.path),
});

export const memoryCommand = defineCommand({
  meta: { name: 'memory', description: 'Inspect stored memories' },
  subCommands: { list: memoryListCommand, show: memoryShowCommand },
});
