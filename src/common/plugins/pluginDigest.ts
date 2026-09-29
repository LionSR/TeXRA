// What the trust in an installed plugin covers: a digest of every file the
// plugin ships and of what its MCP servers run. That digest is not the
// config revision a tool's identity carries (`@tools/liveTools`): it changes
// when anything the plugin ships or runs changes, and a changed digest asks
// for trust again.

// Node imports
import { createHash } from 'node:crypto';
import * as path from 'node:path';

// Third-party imports
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Option,
  type PlatformError,
} from 'effect';
import { LRUCache } from 'lru-cache';
import stableStringify from 'safe-stable-stringify';

// Local imports - utilities
import { isPathWithin } from '@utils/core/pathCore';
import { absentReason } from '@utils/files/fsEntryExists';
import { whichOnExtendedPath } from '@utils/system/platformPaths';

// Local imports - plugin reading
import { envDigest, type McpServerConfig } from './mcpServers';
import { pinHook } from './pluginHooks';
import { PluginError, type ResolvedPlugin } from './pluginManifest';

const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');

/** How recent a modification keeps a file out of the hash cache. */
const RACY_MS = 2_000;

/**
 * Content hashes by (path, inode, size, mtime), for this process: a plugin's files
 * are digested at every step that loads it, and an unchanged file is read
 * once. An entry holds only a hash of the bytes its key names; past the
 * bound the least recently used go, so edits leave no unbounded trail.
 */
const ContentHashes = Context.Reference('@texra/PluginContentHashes', {
  defaultValue: () => new LRUCache<string, string>({ max: 10_000 }),
});

/**
 * Every file under the plugin root, as sorted `[path, sha256]` pairs; `.git`
 * is skipped, and a symlink digests its target text rather than following
 * it. Any edit inside the plugin, a script a server imports included,
 * changes it.
 */
const pluginFiles = Effect.fn('pluginDigest.pluginFiles')(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const hashes = yield* ContentHashes;
  const files: [string, string][] = [];
  const walk = (
    dir: string,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      for (const name of yield* fs.readDirectory(dir)) {
        const full = path.join(dir, name);
        const relative = path.relative(root, full);
        // `readLink` answers lstat's half (`FileSystem` has no lstat): a
        // path it reads is a link, digested as its target text.
        const link = yield* fs
          .readLink(full)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        if (link !== undefined) {
          files.push([relative, `-> ${link}`]);
          continue;
        }
        const info = yield* fs.stat(full);
        if (info.type === 'Directory') {
          if (name !== '.git') yield* walk(full);
        } else if (info.type === 'File') {
          const mtime = Option.getOrUndefined(info.mtime)?.getTime();
          // git's racy rule: a file modified within RACY_MS of now may be
          // written again under the same (rounded) mtime and size, so it is
          // hashed fresh and not cached; nor is one with no mtime.
          const cacheable =
            mtime !== undefined &&
            (yield* Clock.currentTimeMillis) - mtime > RACY_MS;
          const key = cacheable
            ? `${full}\0${Option.getOrElse(info.ino, () => '')}\0${info.size}\0${mtime}`
            : undefined;
          let hash = key === undefined ? undefined : hashes.get(key);
          if (hash === undefined) {
            hash = sha256(yield* fs.readFile(full));
            if (key !== undefined) hashes.set(key, hash);
          }
          files.push([relative, hash]);
        }
      }
    });
  yield* walk(root).pipe(
    Effect.mapError(
      (error) =>
        new PluginError({
          message: `Could not read the plugin at ${root}: ${error.message}`,
        }),
    ),
  );
  return files.toSorted(([a], [b]) => Number(a > b) - Number(a < b));
});

/** A file a server names that lies outside the plugin: trusted by its
 *  resolved path, size and modification time, not its content. */
interface ExternalFile {
  readonly role: 'command' | 'file';
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number | null;
}

/**
 * The files outside the plugin a server runs or names: the executable its
 * command resolves to (a path against the plugin, or a name on PATH), and
 * each argument that is an existing file. They are not hashed, so an
 * upgraded runtime asks again without being read on every step, but their
 * content is not pinned. A command that resolves to nothing fails the
 * server's start, loudly; a path that is there but cannot be read fails
 * here.
 */
export const externalFiles = Effect.fn('pluginDigest.externalFiles')(
  function* (root: string, server: McpServerConfig) {
    const fs = yield* FileSystem.FileSystem;
    const realRoot = yield* fs.realPath(root);
    const command =
      server.command.includes('/') || server.command.includes(path.sep)
        ? path.resolve(root, server.command)
        : whichOnExtendedPath(server.command);
    const candidates: (readonly [ExternalFile['role'], string])[] = [
      ...(command === null ? [] : [['command', command] as const]),
      ...server.args.map((arg) => ['file', path.resolve(root, arg)] as const),
    ];
    const found: ExternalFile[] = [];
    for (const [role, candidate] of candidates) {
      // An argument that names nothing is not a file; any other failure is.
      const real = yield* fs
        .realPath(candidate)
        .pipe(Effect.catchIf(absentReason, () => Effect.succeed(undefined)));
      if (real === undefined || isPathWithin(realRoot, real)) continue;
      const info = yield* fs.stat(real);
      if (info.type === 'File')
        found.push({
          role,
          path: real,
          size: Number(info.size),
          mtimeMs: Option.getOrUndefined(info.mtime)?.getTime() ?? null,
        });
    }
    return found;
  },
  Effect.mapError(
    (error) =>
      new PluginError({
        message: `Could not read what a plugin's server runs: ${error.message}`,
      }),
  ),
);

/**
 * sha256 over what the plugin ships and runs: every file under its root;
 * each server's spec, its env values digested under the per-install `key`
 * (never the values themselves), and the files outside the plugin it runs
 * or names; and each hook's files outside the plugin, a script by its
 * content and a program on PATH by its path, size and date.
 */
export const pluginDigest = (
  root: string,
  plugin: ResolvedPlugin,
  key: string,
) =>
  Effect.gen(function* () {
    const files = yield* pluginFiles(root);
    const servers = yield* Effect.forEach(plugin.mcpServers, (server) =>
      Effect.map(externalFiles(root, server), (external) => ({
        name: server.name,
        command: server.command,
        args: server.args,
        env: envDigest(key, server.env),
        external,
      })),
    );
    // Each hook's exact text, and what a static one runs outside the plugin.
    const hooks = yield* Effect.forEach(plugin.hooks.hooks, (hook) =>
      Effect.map(pinHook(root, hook), (pin) => ({
        id: hook.id,
        command: hook.command,
        args: hook.args ?? null,
        pin,
      })),
    );
    return sha256(stableStringify({ files, servers, hooks }) ?? '');
  });
