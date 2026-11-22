import { Effect } from 'effect';
import { Argument, Command } from 'effect/cli';

import { withSessionFs } from '@texra-ai/worldline/host';
import { MemoryStore } from '@texra-ai/worldline/plugins';

import { CliExitCode } from '../runtime/platform/exitCodes';
import { cliPlatform } from '../runtime/platform/initPlatform';
import {
  formatCliMemoryList,
  formatCliMemoryPreview,
  loadCliMemoryDetail,
} from '../runtime/memory';

import { cliCommand } from './_helpers/cliCommand';
import { cliResult, emitCliResult } from './_helpers/output';

const runMemoryList = Effect.fn('runMemoryList')(function* () {
  const services = yield* cliPlatform;
  // Pass the full list to `formatCliMemoryList`; it owns truncation (the
  // `Memories (N):` total and `… N more rows` overflow line) and JSON/NDJSON
  // consumers should see every memory, not a capped slice.
  const items = yield* withSessionFs(services.roots, MemoryStore.list);

  yield* emitCliResult(cliResult('memory', items, formatCliMemoryList(items)));
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
});

const memoryListCommand = cliCommand('list', {
  description: 'List stored memories',
  config: {},
  catchExitCode: CliExitCode.AgentError,
  run: () => runMemoryList(),
});

const memoryShowCommand = cliCommand('show', {
  description: 'Show one stored memory',
  config: {
    path: Argument.String('path').pipe(
      Argument.withDescription(
        'Memory path from `texra memory list` (e.g. memories/<file>)',
      ),
    ),
  },
  catchExitCode: CliExitCode.Usage,
  run: (_, input) => runMemoryShow(input.path),
});

export const memoryCommand = Command.make('memory').pipe(
  Command.withDescription('Inspect stored memories'),
  Command.withSubcommands([memoryListCommand, memoryShowCommand]),
);
