/**
 * `texra doctor --prune-storage`: list the
 * workspace stores whose project is gone and the old aside copies beside the
 * stores that remain (`readStorageInventory`), and delete them once the user
 * confirms.
 */
import { Effect, Number as Num } from 'effect';

import {
  deleteStorageInventory,
  readStorageInventory,
} from '@texra-ai/worldline/host';
import { formatResultCount } from '@texra-ai/worldline/schemas';
import { formatBytes } from '@ui/copy/format';

import { CliExitCode } from './platform/exitCodes';
import {
  confirmCliQuestion,
  writeTextStderr,
  writeTextStdout,
} from './platform/logSinks';
import type { CliContext } from './platform/cliContext';

export const pruneStorage = Effect.fn('pruneStorage')(function* (
  context: CliContext,
  yes: boolean,
) {
  const inventory = yield* readStorageInventory(context.storageRoot);
  for (const { path, message } of inventory.skipped)
    writeTextStderr(`Skipped ${path}: ${message}`);
  const { orphans, asides } = inventory;
  if (orphans.length === 0 && asides.length === 0) {
    writeTextStdout('No orphaned project stores or corrupt backups found.');
    return CliExitCode.Success;
  }
  const listed = (
    count: string,
    rows: readonly { bytes: number; line: string }[],
  ) => [
    `${count}, ${formatBytes(Num.sumAll(rows.map((row) => row.bytes)))}:`,
    ...rows.map(
      (row) => `  ${formatBytes(row.bytes).padStart(9)}  ${row.line}`,
    ),
  ];
  writeTextStdout(
    [
      ...(orphans.length === 0
        ? []
        : listed(
            formatResultCount(orphans.length, 'orphaned project store'),
            orphans.map((orphan) => ({
              bytes: orphan.bytes,
              line: `${orphan.directory}  (${orphan.why})`,
            })),
          )),
      ...(asides.length === 0
        ? []
        : listed(
            formatResultCount(asides.length, 'corrupt backup'),
            asides.map((aside) => ({ bytes: aside.bytes, line: aside.path })),
          )),
    ].join('\n'),
  );
  const count = formatResultCount(
    orphans.length + asides.length,
    'listed item',
  );
  const confirmed =
    yes ||
    (context.mode === 'interactive' &&
      (yield* confirmCliQuestion(`Delete ${count}?`, { default: false })));
  if (!confirmed) {
    writeTextStderr('Nothing was deleted. Re-run with --yes to delete them.');
    return CliExitCode.Success;
  }
  for (const result of yield* deleteStorageInventory(
    context.storageRoot,
    inventory,
  )) {
    if (result.outcome === 'deleted') writeTextStdout(`Deleted ${result.path}`);
    else if (result.outcome === 'kept')
      writeTextStderr(`Kept ${result.path}: it is open in another process.`);
    else writeTextStderr(`Skipped ${result.path}: ${result.message}`);
  }
  return CliExitCode.Success;
});
