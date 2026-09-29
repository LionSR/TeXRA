/**
 * `texra doctor --prune-storage` (the storage design's §7): list the
 * workspace stores whose project is gone, and delete them once the user
 * confirms. Owner ruling Q4: whole stores go only by this command, never
 * automatically, since an unmounted drive looks exactly like a deleted root.
 *
 * A store is an orphan when the root its `workspace-store` record names no
 * longer exists, or, with no record (no 1.0 host opened it), when nothing in
 * it changed for 90 days. The store of no workspace has no root and is never
 * one.
 */
import { basename, dirname, join } from 'node:path';

import { Clock, Effect, FileSystem, Option } from 'effect';

import { storeOpenElsewhere } from '@controllers/session/Database';
import { resolveWorkspaceStoragePath } from '@platform/defaults/workspaceStorage';
import { GlobalDatabase } from '@shared/session/database';
import { formatBytes, formatResultCount } from '@utils/text/stringUtils';

import { CliExitCode } from './exitCodes';
import { askCliQuestion, writeTextStderr, writeTextStdout } from './logSinks';
import type { CliContext } from './cliContext';

const UNRECORDED_ORPHAN_MS = 90 * 24 * 60 * 60 * 1000;

export const pruneStorage = Effect.fn('pruneStorage')(function* (
  context: CliContext,
  yes: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const { values } = yield* GlobalDatabase;
  const none = resolveWorkspaceStoragePath(context.storageRoot, undefined);
  const parent = dirname(none);
  const records = new Map(
    (yield* values.list('workspace-store')).map((row) => [row.key, row.value]),
  );
  const now = yield* Clock.currentTimeMillis;
  const orphans: { directory: string; bytes: number; why: string }[] = [];
  const ids = (yield* fs.exists(parent)) ? yield* fs.readDirectory(parent) : [];
  for (const id of ids.toSorted()) {
    const directory = join(parent, id);
    if (id === basename(none)) continue;
    if ((yield* fs.stat(directory)).type !== 'Directory') continue;
    let bytes = 0;
    let latest = 0;
    for (const name of yield* fs.readDirectory(directory, {
      recursive: true,
    })) {
      const info = yield* fs.stat(join(directory, name));
      if (info.type !== 'File') continue;
      bytes += Number(info.size);
      latest = Math.max(
        latest,
        Option.getOrElse(info.mtime, () => new Date(now)).getTime(),
      );
    }
    const record = records.get(id);
    if (record !== undefined && !(yield* fs.exists(record.root)))
      orphans.push({
        directory,
        bytes,
        why: `${record.root} no longer exists`,
      });
    else if (record === undefined && now - latest > UNRECORDED_ORPHAN_MS)
      orphans.push({
        directory,
        bytes,
        why: 'no record, unchanged for 90 days',
      });
  }
  if (orphans.length === 0) {
    writeTextStdout('No orphaned workspace stores.');
    return CliExitCode.Success;
  }
  const total = orphans.reduce((sum, orphan) => sum + orphan.bytes, 0);
  writeTextStdout(
    [
      `${formatResultCount(orphans.length, 'orphaned workspace store')}, ${formatBytes(total)}:`,
      ...orphans.map(
        (orphan) =>
          `  ${formatBytes(orphan.bytes).padStart(9)}  ${orphan.directory}  (${orphan.why})`,
      ),
    ].join('\n'),
  );
  const confirmed =
    yes ||
    (context.mode === 'interactive' &&
      /^y(es)?$/i.test(
        (yield* askCliQuestion(
          `Delete ${formatResultCount(orphans.length, 'store')}? [y/N] `,
        )).trim(),
      ));
  if (!confirmed) {
    writeTextStderr('Nothing was deleted. Re-run with --yes to delete them.');
    return CliExitCode.Success;
  }
  for (const { directory } of orphans) {
    const database = join(directory, 'texra.db');
    if ((yield* fs.exists(database)) && (yield* storeOpenElsewhere(database))) {
      writeTextStderr(`Kept ${directory}: it is open in another process.`);
      continue;
    }
    yield* fs.remove(directory, { recursive: true });
    writeTextStdout(`Deleted ${directory}`);
  }
  return CliExitCode.Success;
});
