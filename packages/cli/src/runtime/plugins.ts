// `texra plugin`: fetch a Claude Code or Codex plugin, pin it, and record it
// in `texra.plugins.installed`, whose skill roots the skill catalog reads.
// Nothing from a plugin runs: git only fetches, and v1 reads skills alone.

import { cp } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, FileSystem, Stream } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';

import type { SettingsStores } from '@shared/config/settingsAccess';
import type { InstalledPlugin } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  inspectSettingFrom,
  writeSettingTo,
} from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { makeMachineGitEnv } from '@utils/system/gitEnv';

import { CliUsageError } from './cliContext';
import {
  countSkills,
  PluginError,
  pluginFsError,
  readPlugin,
  readPluginCandidates,
  type PluginCandidate,
} from './pluginManifest';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/** Where a plugin comes from, as the user named it. */
export type PluginOrigin =
  | { readonly kind: 'git'; readonly url: string; readonly ref?: string }
  | { readonly kind: 'local'; readonly path: string };

/** The setting slots the record lives in and the managed plugin directory. */
export interface PluginEnv {
  readonly stores: SettingsStores;
  /** `<storage root>/plugins`; each fetched plugin lives in `<name>/` here. */
  readonly pluginsDir: string;
}

// Remote transports only: a local repository is installed by its path, so a
// marketplace cannot name `file://` to copy another checkout on this machine.
export const GIT_URL = /^(?:(?:https?|ssh|git):\/\/|[\w.-]+@[\w.-]+:)/;
/** A ref git takes as a plain name: no leading dash, no option smuggling. */
export const SAFE_REF = /^[\w][\w./-]*$/;

// Machine git env only: extending would merge back the helper-invoking keys
// makeMachineGitEnv strips. A failure names the command and git's stderr.
function git(
  args: readonly string[],
): Effect.Effect<string, PluginError, ChildProcessSpawner> {
  const commandLine = `git ${args.join(' ')}`;
  return Effect.gen(function* () {
    const handle = yield* ChildProcess.make('git', args, {
      env: makeMachineGitEnv(),
      extendEnv: false,
      stdin: 'ignore',
      detached: false,
      forceKillAfter: '5 seconds',
    });
    const [stdout, stderr, code] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: 'unbounded' },
    );
    return { stdout, stderr: stderr.trim(), code };
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => {
      const message = `${commandLine} could not start: ${toErrorMessage(error)}`;
      return new PluginError({ message });
    }),
    Effect.flatMap(({ stdout, stderr, code }) =>
      code === 0
        ? Effect.succeed(stdout.trim())
        : Effect.fail(
            new PluginError({
              message: `${commandLine} exited with code ${code}${stderr ? `: ${stderr}` : ''}`,
            }),
          ),
    ),
  );
}

/**
 * Check `rev` out detached in `dir`, forced and cleaned, so the directory
 * matches that commit exactly. Symlinks check out as plain files, so nothing
 * in the tree can point outside it.
 */
function checkoutDetached(dir: string, rev: string) {
  const inDir = ['-C', dir, '-c', 'core.symlinks=false'];
  return git([
    ...inDir,
    '-c',
    'advice.detachedHead=false',
    'checkout',
    '--quiet',
    '--force',
    '--detach',
    rev,
  ]).pipe(Effect.andThen(git([...inDir, 'clean', '--quiet', '-ffdx'])));
}

/**
 * Fetch `ref` (the remote's HEAD when absent) from `url` into `dir` and check
 * it out, returning the commit. Install and update take the same steps: a
 * shallow fetch of exactly one commit, then {@link checkoutDetached}.
 */
function fetchPinned(dir: string, url: string, ref: string | undefined) {
  return Effect.gen(function* () {
    yield* git(['init', '--quiet', dir]);
    yield* git([
      ...['-C', dir, '-c', 'protocol.file.allow=never', 'fetch', '--quiet'],
      ...['--depth', '1', '--no-tags'],
      ...['--', url, ref ?? 'HEAD'],
    ]);
    yield* checkoutDetached(dir, 'FETCH_HEAD');
    return yield* git(['-C', dir, 'rev-parse', 'HEAD']);
  });
}

const removeDir = (dir: string) =>
  FileSystem.FileSystem.use((fs) =>
    fs.remove(dir, { recursive: true, force: true }),
  ).pipe(Effect.mapError(pluginFsError));

/** Cleanup after a failure: a directory left behind is named, not hidden. */
const cleanupDir = (dir: string) =>
  removeDir(dir).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Could not remove ${dir}: ${error.message}`),
    ),
  );

/**
 * The recorded plugins. Every command here rewrites the whole list, so an
 * invalid stored list stops it rather than reading as empty and being lost.
 */
function readInstalledPlugins(stores: SettingsStores) {
  return inspectSettingFrom<InstalledPlugin[]>(
    stores,
    GlobalStateKey.INSTALLED_PLUGINS,
  ).pipe(
    Effect.flatMap((stored) =>
      stored.kind === 'value'
        ? Effect.succeed(stored.value)
        : Effect.fail(
            new PluginError({
              message: `The installed plugin list (${GlobalStateKey.INSTALLED_PLUGINS}) is unreadable: ${stored.cause}`,
            }),
          ),
    ),
  );
}

function writeInstalledPlugins(
  stores: SettingsStores,
  plugins: readonly InstalledPlugin[],
) {
  return writeSettingTo(stores, GlobalStateKey.INSTALLED_PLUGINS, plugins);
}

/** Where the plugins of one fetch came from. */
type Fetched =
  | { readonly kind: 'local' }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly ref?: string;
      readonly commit: string;
    };

interface InstallRun {
  readonly env: PluginEnv;
  /** Names already recorded or claimed earlier in this install. */
  readonly taken: Set<string>;
  /** Managed directories this install created, removed if it fails. */
  readonly created: string[];
}

function claimName(run: InstallRun, name: string) {
  if (run.taken.has(name)) {
    return Effect.fail(
      new CliUsageError(
        `A plugin named ${name} is already installed. Run \`texra plugin update ${name}\`, or remove it first.`,
      ),
    );
  }
  run.taken.add(name);
  return Effect.void;
}

function installFromRoot(
  root: string,
  fetched: Fetched,
  only: readonly string[],
  run: InstallRun,
  nested: boolean,
): Effect.Effect<
  InstalledPlugin[],
  PluginError | CliUsageError | Error,
  ChildProcessSpawner | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const candidates: readonly PluginCandidate[] = yield* readPluginCandidates(
      root,
      only,
    );
    const records: InstalledPlugin[] = [];
    for (const candidate of candidates) {
      if (candidate.kind === 'git') {
        if (nested) {
          return yield* Effect.fail(
            new PluginError({
              message: `${candidate.url} is listed by a marketplace that was itself listed by one; TeXRA follows one level.`,
            }),
          );
        }
        records.push(...(yield* installOrigin(candidate, [], run, true)));
        continue;
      }
      const plugin = yield* readPlugin(candidate.dir, candidate.entry);
      yield* claimName(run, plugin.name);
      if (fetched.kind === 'local') {
        records.push({
          name: plugin.name,
          source: candidate.dir,
          path: candidate.dir,
          skills: plugin.skills.map((skill) => path.join(candidate.dir, skill)),
        });
        continue;
      }
      // Each fetched plugin gets its own managed copy of the checkout, so
      // update and remove act on one plugin without touching another.
      const dest = path.join(run.env.pluginsDir, plugin.name);
      // A plain mkdir claims the directory: it fails if anything is there.
      yield* FileSystem.FileSystem.use((fs) => fs.makeDirectory(dest)).pipe(
        Effect.mapError((error) =>
          error.reason._tag === 'AlreadyExists'
            ? new PluginError({
                message: `${dest} already exists but no installed plugin records it. Delete it, then install again.`,
              })
            : pluginFsError(error),
        ),
      );
      run.created.push(dest);
      // Node's `cp`, not `FileSystem.copy`: only it keeps a relative link
      // verbatim instead of pointing it into the soon-removed staging dir.
      yield* Effect.tryPromise({
        try: () => cp(root, dest, { recursive: true, verbatimSymlinks: true }),
        catch: (error) => new PluginError({ message: toErrorMessage(error) }),
      });
      const pluginPath = path.join(dest, path.relative(root, candidate.dir));
      records.push({
        name: plugin.name,
        source: fetched.url,
        ...(fetched.ref ? { ref: fetched.ref } : {}),
        commit: fetched.commit,
        path: pluginPath,
        skills: plugin.skills.map((skill) => path.join(pluginPath, skill)),
      });
    }
    return records;
  });
}

function installOrigin(
  origin: PluginOrigin,
  only: readonly string[],
  run: InstallRun,
  nested: boolean,
): Effect.Effect<
  InstalledPlugin[],
  PluginError | CliUsageError | Error,
  ChildProcessSpawner | FileSystem.FileSystem
> {
  if (origin.kind === 'local') {
    return FileSystem.FileSystem.use((fs) => fs.realPath(origin.path)).pipe(
      Effect.mapError(
        () =>
          new CliUsageError(
            `${origin.path} is not a directory, a git URL, or github.com/<owner>/<repo>.`,
          ),
      ),
      Effect.flatMap((root) =>
        installFromRoot(root, { kind: 'local' }, only, run, nested),
      ),
    );
  }
  // A marketplace names its git sources itself, so they pass the same checks
  // a typed source does before git sees them.
  if (
    !GIT_URL.test(origin.url) ||
    (origin.ref !== undefined && !SAFE_REF.test(origin.ref))
  ) {
    return Effect.fail(
      new PluginError({
        message: `Refusing git source ${origin.url}${origin.ref ? ` at "${origin.ref}"` : ''}: not a git URL and plain ref.`,
      }),
    );
  }
  // Fetch into a staging directory beside the managed ones; it is removed
  // however the install ends, and each plugin is copied out of it.
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = run.env.pluginsDir;
      yield* fs.makeDirectory(directory, { recursive: true });
      return yield* fs.makeTempDirectory({ directory, prefix: '.staging-' });
    }).pipe(Effect.mapError(pluginFsError)),
    (staging) =>
      fetchPinned(staging, origin.url, origin.ref).pipe(
        Effect.flatMap((commit) =>
          installFromRoot(
            staging,
            { kind: 'git', url: origin.url, ref: origin.ref, commit },
            only,
            run,
            nested,
          ),
        ),
      ),
    (staging) => cleanupDir(staging),
  );
}

/**
 * Install the plugin(s) `origin` offers and record them. The record is
 * written once, after every plugin is in place; a failure removes the managed
 * directories this install created and records nothing.
 */
export function installPlugins(
  origin: PluginOrigin,
  only: readonly string[],
  env: PluginEnv,
) {
  return Effect.gen(function* () {
    const installed = yield* readInstalledPlugins(env.stores);
    const run: InstallRun = {
      env,
      taken: new Set(installed.map((plugin) => plugin.name)),
      created: [],
    };
    return yield* installOrigin(origin, only, run, false).pipe(
      Effect.tap((records) =>
        writeInstalledPlugins(env.stores, [...installed, ...records]),
      ),
      Effect.onError(() => Effect.forEach(run.created, cleanupDir)),
    );
  });
}

function requireInstalled(installed: readonly InstalledPlugin[], name: string) {
  const found = installed.find((plugin) => plugin.name === name);
  if (found) return Effect.succeed(found);
  const names = installed.map((plugin) => plugin.name);
  return Effect.fail(
    new CliUsageError(
      names.length === 0
        ? `No plugin named ${name} is installed. No plugins are installed.`
        : `No plugin named ${name} is installed. Installed: ${names.join(', ')}.`,
    ),
  );
}

/**
 * Forget a plugin and delete its managed directory. A local plugin is only
 * forgotten; its directory is the user's. The record is written first, so a
 * failed delete leaves an unreferenced directory rather than a record
 * pointing at a half-deleted one.
 */
export function removePlugin(name: string, env: PluginEnv) {
  return Effect.gen(function* () {
    const installed = yield* readInstalledPlugins(env.stores);
    const plugin = yield* requireInstalled(installed, name);
    yield* writeInstalledPlugins(
      env.stores,
      installed.filter((entry) => entry.name !== name),
    );
    if (plugin.commit !== undefined) {
      yield* removeDir(path.join(env.pluginsDir, plugin.name));
    }
    return plugin;
  });
}

/**
 * Reread a recorded plugin's manifest. Its record stands in for a manifest
 * it never had (a plugin a marketplace entry described).
 */
function rereadPlugin(plugin: InstalledPlugin) {
  return readPlugin(plugin.path, {
    name: plugin.name,
    skills: plugin.skills.map((skill) => path.relative(plugin.path, skill)),
  });
}

/** One plugin's update: the commit it moved from and to, when fetched. */
export interface PluginUpdate {
  readonly name: string;
  readonly from?: string;
  readonly to?: string;
}

/**
 * Update the named plugins, or every one. A fetched plugin refetches its ref
 * into its managed directory and pins the new commit; every plugin rereads
 * its manifest, so a changed `skills` path takes effect. Each plugin is
 * recorded as soon as it is updated, and one whose new commit cannot be read
 * is checked back out at its recorded commit, so the record and the
 * directory never disagree.
 */
export function updatePlugins(names: readonly string[], env: PluginEnv) {
  return Effect.gen(function* () {
    let current = yield* readInstalledPlugins(env.stores);
    const targets =
      names.length === 0
        ? current
        : yield* Effect.forEach(names, (name) =>
            requireInstalled(current, name),
          );
    const updates: PluginUpdate[] = [];
    for (const plugin of targets) {
      const dir = path.join(env.pluginsDir, plugin.name);
      const commit =
        plugin.commit === undefined
          ? undefined
          : yield* fetchPinned(dir, plugin.source, plugin.ref);
      const skills = yield* rereadPlugin(plugin).pipe(
        Effect.map((resolved) =>
          resolved.skills.map((skill) => path.join(plugin.path, skill)),
        ),
        Effect.tapError(() =>
          plugin.commit === undefined
            ? Effect.void
            : checkoutDetached(dir, plugin.commit).pipe(
                // The reread failure is the one to report; a failed restore
                // is named beside it.
                Effect.catch((error) =>
                  Effect.logWarning(
                    `Could not restore ${dir} to ${plugin.commit}: ${error.message}`,
                  ),
                ),
              ),
        ),
      );
      const updated = { ...plugin, ...(commit ? { commit } : {}), skills };
      current = current.map((entry) =>
        entry.name === plugin.name ? updated : entry,
      );
      yield* writeInstalledPlugins(env.stores, current);
      updates.push({ name: plugin.name, from: plugin.commit, to: commit });
    }
    return updates;
  });
}

/** One installed plugin as `texra plugin list` reports it. */
export interface PluginListing extends InstalledPlugin {
  readonly version?: string;
  readonly description?: string;
  readonly skillCount: number;
  readonly ignored: readonly string[];
  /** Why the plugin cannot be read now, when it cannot. */
  readonly problem?: string;
}

export function listPlugins(env: PluginEnv) {
  return Effect.gen(function* () {
    const installed = yield* readInstalledPlugins(env.stores);
    return yield* Effect.forEach(installed, (plugin) =>
      Effect.gen(function* () {
        const resolved = yield* rereadPlugin(plugin);
        const counts = yield* Effect.forEach(plugin.skills, countSkills);
        return {
          ...plugin,
          version: resolved.version,
          description: resolved.description,
          skillCount: counts.reduce((sum, count) => sum + count, 0),
          ignored: resolved.ignored,
        } satisfies PluginListing;
      }).pipe(
        Effect.catchTag('PluginError', (error) =>
          Effect.succeed({
            ...plugin,
            skillCount: 0,
            ignored: [],
            problem: error.message,
          } satisfies PluginListing),
        ),
      ),
    );
  });
}
