/**
 * `texra doctor --prune-storage` (the storage design's §7): list the
 * workspace stores whose project is gone and the old aside copies beside the
 * stores that remain (`readStorageInventory`), and delete them once the user
 * confirms.
 */
import { Effect } from 'effect';

import {
  deleteStorageInventory,
  readStorageInventory,
} from '@texra-ai/harness';
import { formatBytes, formatResultCount } from '@utils/text/stringUtils';

import { CliExitCode } from './exitCodes';
import { askCliQuestion, writeTextStderr, writeTextStdout } from './logSinks';
import type { CliContext } from './cliContext';

export const pruneStorage = Effect.fn('pruneStorage')(function* (
  context: CliContext,
  yes: boolean,
) {
  const inventory = yield* readStorageInventory(context.storageRoot);
  for (const { path, message } of inventory.skipped)
    writeTextStderr(`Skipped ${path}: ${message}`);
  const { orphans, asides } = inventory;
  if (orphans.length === 0 && asides.length === 0) {
    writeTextStdout('No orphaned workspace stores and no aside copies.');
    return CliExitCode.Success;
  }
  const listed = (
    count: string,
    rows: readonly { bytes: number; line: string }[],
  ) => [
    `${count}, ${formatBytes(rows.reduce((sum, row) => sum + row.bytes, 0))}:`,
    ...rows.map(
      (row) => `  ${formatBytes(row.bytes).padStart(9)}  ${row.line}`,
    ),
  ];
  writeTextStdout(
    [
      ...(orphans.length === 0
        ? []
        : listed(
            formatResultCount(orphans.length, 'orphaned workspace store'),
            orphans.map((orphan) => ({
              bytes: orphan.bytes,
              line: `${orphan.directory}  (${orphan.why})`,
            })),
          )),
      ...(asides.length === 0
        ? []
        : listed(
            formatResultCount(asides.length, 'aside copy', 'aside copies'),
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
      /^y(es)?$/i.test(
        (yield* askCliQuestion(`Delete ${count}? [y/N] `)).trim(),
      ));
  if (!confirmed) {
    writeTextStderr('Nothing was deleted. Re-run with --yes to delete them.');
    return CliExitCode.Success;
  }
  for (const result of yield* deleteStorageInventory(inventory)) {
    if (result.outcome === 'deleted') writeTextStdout(`Deleted ${result.path}`);
    else if (result.outcome === 'kept')
      writeTextStderr(`Kept ${result.path}: it is open in another process.`);
    else writeTextStderr(`Skipped ${result.path}: ${result.message}`);
  }
  return CliExitCode.Success;
});
