/**
 * `texra doctor --prune-storage` (the storage design's §7): list the
 * workspace stores whose project is gone and the old aside copies beside the
 * stores that remain, and delete them once the user confirms. Owner ruling
 * Q4: whole stores and history copies go only by this command, never
 * automatically, since an unmounted drive looks exactly like a deleted root.
 *
 * A store is an orphan when the root its `workspace-store` record names no
 * longer exists, or, with no record (no 1.0 host opened it), when nothing in
 * it changed for 90 days. The store of no workspace has no root and is never
 * one. An old aside copy (`oldAsides`) is a pre-1.0 build's `.format<N>`,
 * which nothing else removes, or a `.pre1` or `.corrupt-` copy over 30 days
 * old beside a store no host has opened since.
 */
import { basename, dirname, join } from 'node:path';

import { Clock, Effect, FileSystem, Option } from 'effect';

import { storeOpenElsewhere } from '@controllers/session/Database';
import { oldAsides } from '@controllers/session/storeAside';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { GlobalDatabase } from '@shared/session/database';
import { WORKSPACE_STORES } from '@shared/session/valueFamily';
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
    (yield* values.list(WORKSPACE_STORES)).map((row) => [row.key, row.value]),
  );
  const now = yield* Clock.currentTimeMillis;
  /** Why a store directory is an orphan, with its size, or null while its
   *  root stands. A store whose database is not SQLite is still an orphan. */
  const inspect = Effect.fnUntraced(function* (directory: string, id: string) {
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
    let why: string | null = null;
    if (record !== undefined && !(yield* fs.exists(record.root)))
      why = `${record.root} no longer exists`;
    else if (record === undefined && now - latest > UNRECORDED_ORPHAN_MS)
      why = 'no record, unchanged for 90 days';
    if (why === null) return null;
    const database = join(directory, 'texra.db');
    if (
      (yield* fs.exists(database)) &&
      (yield* storeOpenElsewhere(database)) === 'unreadable'
    )
      why += '; unreadable (not a SQLite store)';
    return { directory, bytes, why };
  });
  /** One store's failure is reported and the run goes on to the next. */
  const skipped = (directory: string) => (error: Error) =>
    Effect.sync(() => {
      writeTextStderr(`Skipped ${directory}: ${error.message}`);
    });
  const orphans: { directory: string; bytes: number; why: string }[] = [];
  const asides: { path: string; bytes: number; legacy: boolean }[] = [];
  const ids = (yield* fs.exists(parent)) ? yield* fs.readDirectory(parent) : [];
  const global = resolveGlobalStoragePath(context.storageRoot);
  const directories = [
    ...((yield* fs.exists(global)) ? [global] : []),
    ...ids.toSorted().map((id) => join(parent, id)),
  ];
  for (const directory of directories) {
    yield* Effect.gen(function* () {
      if ((yield* fs.stat(directory)).type !== 'Directory') return;
      const id = basename(directory);
      const orphan =
        directory === global || id === basename(none)
          ? null
          : yield* inspect(directory, id);
      if (orphan !== null) orphans.push(orphan);
      else asides.push(...(yield* oldAsides(join(directory, 'texra.db'))));
    }).pipe(Effect.catch(skipped(directory)));
  }
  if (orphans.length === 0 && asides.length === 0) {
    writeTextStdout('No orphaned workspace stores and no old aside copies.');
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
            formatResultCount(
              asides.length,
              'old aside copy',
              'old aside copies',
            ),
            asides.map((aside) => ({
              bytes: aside.bytes,
              line: `${aside.path}${aside.legacy ? '  (pre-1.0 history copy)' : ''}`,
            })),
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
  for (const { directory } of orphans) {
    yield* Effect.gen(function* () {
      const database = join(directory, 'texra.db');
      if (
        (yield* fs.exists(database)) &&
        (yield* storeOpenElsewhere(database)) === 'open'
      ) {
        writeTextStderr(`Kept ${directory}: it is open in another process.`);
        return;
      }
      yield* fs.remove(directory, { recursive: true });
      writeTextStdout(`Deleted ${directory}`);
    }).pipe(Effect.catch(skipped(directory)));
  }
  for (const { path } of asides) {
    yield* fs
      .remove(path, { force: true })
      .pipe(
        Effect.andThen(Effect.sync(() => writeTextStdout(`Deleted ${path}`))),
        Effect.catch(skipped(path)),
      );
  }
  return CliExitCode.Success;
});
