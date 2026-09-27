// What the trust in an installed plugin covers: a digest of every file the
// plugin ships and of what its MCP servers run. That digest is not the
// config revision a tool's identity carries (`@tools/liveTools`): it changes
// when anything the plugin ships or runs changes, and a changed digest asks
// for trust again.

// Node imports
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import stableStringify from 'safe-stable-stringify';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';
import { whichOnExtendedPath } from '@utils/system/platformPaths';

// Local imports - plugin reading
import { envDigest, type McpServerConfig } from './mcpServers';
import { PluginError, type ResolvedPlugin } from './pluginManifest';

const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};

/**
 * Content hashes by (path, size, mtime), for this process: a plugin's files
 * are digested at every step that loads it, and an unchanged file is read
 * once. An entry holds only a hash of the bytes its key names.
 */
const contentHashes = new Map<string, string>();

/**
 * Every file under the plugin root, as sorted `[path, sha256]` pairs; `.git`
 * is skipped, and a symlink digests its target text rather than following
 * it. Any edit inside the plugin, a script a server imports included,
 * changes it.
 */
const pluginFiles = (root: string) =>
  Effect.tryPromise({
    try: async () => {
      const files: [string, string][] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const relative = path.relative(root, full);
          if (entry.isDirectory()) {
            if (entry.name !== '.git') await walk(full);
          } else if (entry.isSymbolicLink()) {
            files.push([relative, `-> ${await fs.readlink(full)}`]);
          } else if (entry.isFile()) {
            const stat = await fs.stat(full);
            const key = `${full}\0${stat.size}\0${stat.mtimeMs}`;
            let hash = contentHashes.get(key);
            if (hash === undefined) {
              hash = sha256(await fs.readFile(full));
              contentHashes.set(key, hash);
            }
            files.push([relative, hash]);
          }
        }
      };
      await walk(root);
      return files.toSorted(([a], [b]) => Number(a > b) - Number(a < b));
    },
    catch: (error) =>
      new PluginError({
        message: `Could not read the plugin at ${root}: ${toErrorMessage(error)}`,
      }),
  });

/** A file a server names that lies outside the plugin: trusted by its
 *  resolved path, size and modification time, not its content. */
interface ExternalFile {
  readonly role: 'command' | 'file';
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * The files outside the plugin a server runs or names: the executable its
 * command resolves to (a path against the plugin, or a name on PATH), and
 * each argument that is an existing file. They are not hashed, so an
 * upgraded runtime asks again without being read on every step, but their
 * content is not pinned. A command that resolves to nothing fails the
 * server's start, loudly.
 */
export const externalFiles = (root: string, server: McpServerConfig) =>
  Effect.promise(async () => {
    const realRoot = await fs.realpath(root);
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
      const real = await fs.realpath(candidate).catch(() => null);
      if (real === null || within(realRoot, real)) continue;
      const stat = await fs.stat(real);
      if (stat.isFile())
        found.push({
          role,
          path: real,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
    }
    return found;
  });

/**
 * sha256 over what the plugin ships and runs: every file under its root,
 * and each server's spec, its env values digested under the per-install
 * `key` (never the values themselves), and the files outside the plugin it
 * runs or names.
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
    return sha256(stableStringify({ files, servers }) ?? '');
  });
