// Installing Claude Code and Codex plugins: fetch or reference one, pin it,
// and record it in `texra.plugins.installed`, the one install record the
// CLI, the extension and the desktop read and write. Nothing from a plugin
// runs here: git only fetches, and an install records the plugin disabled
// until the user enables it and trusts the version it is at (`./pluginTrust`).

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Effect, Result } from 'effect';

import type { InstalledPlugin } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  findInstalled,
  modifyInstalled,
  modifyTrusted,
  readPluginState,
  type PluginEnv,
} from './installRecord';
import { readPluginCandidates, type PluginCandidate } from './marketplace';
import { checkoutDetached, fetchPinned } from './pluginGit';
import {
  PluginError,
  PluginRequestError,
  readPlugin,
  type ResolvedPlugin,
} from './pluginManifest';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/** Where a plugin comes from, as the user named it. */
export type PluginOrigin =
  | { readonly kind: 'git'; readonly url: string; readonly ref?: string }
  | { readonly kind: 'local'; readonly path: string };

/** `<global storage>/plugins`: each fetched plugin lives in `<name>/` here. */
const pluginsDir = (env: PluginEnv) => path.join(env.globalStorage, 'plugins');

// Remote transports only: a local repository is installed by its path, so a
// marketplace cannot name `file://` to copy another checkout on this machine.
const GIT_URL = /^(?:(?:https?|ssh|git):\/\/|[\w.-]+@[\w.-]+:)/;
/** A ref git takes as a plain name: no leading dash, no option smuggling. */
const SAFE_REF = /^[\w][\w./-]*$/;

const GITHUB_SHORTHAND =
  /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([^@\s]+))?$/;

/**
 * Parse a source as a user types it: `github.com/<owner>/<repo>[@ref]`, a
 * git URL, or a local directory, relative to `cwd`. Refused before anything
 * runs, so a bad source is the user's mistake to correct. `ref` (the CLI's
 * `--ref`) applies to git sources only.
 */
export function parsePluginOrigin(
  input: string,
  cwd: string,
  ref: string | undefined,
): Result.Result<PluginOrigin, PluginRequestError> {
  const refuse = (message: string) =>
    Result.fail(new PluginRequestError({ message }));
  const github = GITHUB_SHORTHAND.exec(input);
  const pinned = github?.[3];
  if (pinned !== undefined && ref !== undefined)
    return refuse(
      `Give the ref once: either ${input} or --ref ${ref}, not both.`,
    );
  const gitRef = pinned ?? ref;
  if (gitRef !== undefined && !SAFE_REF.test(gitRef))
    return refuse(`"${gitRef}" is not a git branch, tag or commit.`);
  const pin = gitRef ? { ref: gitRef } : {};
  if (github)
    return Result.succeed({
      kind: 'git',
      url: `https://github.com/${github[1]}/${github[2]}.git`,
      ...pin,
    });
  if (GIT_URL.test(input))
    return Result.succeed({ kind: 'git', url: input, ...pin });
  if (/^[a-z][\w+.-]*:\/\//i.test(input))
    return refuse(
      `${input} is not a remote git URL (https, ssh or git). Install a local plugin by its directory path.`,
    );
  if (ref !== undefined) return refuse('--ref applies to git sources only.');
  const expanded =
    input === '~' || input.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), input.slice(1))
      : input;
  return Result.succeed({ kind: 'local', path: path.resolve(cwd, expanded) });
}

const fsEffect = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new PluginError({ message: toErrorMessage(error) }),
  });

const removeDir = (dir: string) =>
  fsEffect(() => fs.rm(dir, { recursive: true, force: true }));

/** Cleanup after a failure: a directory left behind is named, not hidden. */
const cleanupDir = (dir: string) =>
  removeDir(dir).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Could not remove ${dir}: ${error.message}`),
    ),
  );

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
  /** Names claimed earlier in this install. */
  readonly taken: Set<string>;
  /** Managed directories this install created, removed if it fails. */
  readonly created: string[];
}

const nameTaken = (name: string) =>
  new PluginRequestError({
    message: `A plugin named ${name} is already installed. Update it, or remove it first.`,
  });

function claimName(run: InstallRun, name: string) {
  if (run.taken.has(name)) return Effect.fail(nameTaken(name));
  run.taken.add(name);
  return Effect.void;
}

type InstallFailure = PluginError | PluginRequestError | Error;

function installFromRoot(
  root: string,
  fetched: Fetched,
  only: readonly string[],
  run: InstallRun,
  nested: boolean,
): Effect.Effect<InstalledPlugin[], InstallFailure, ChildProcessSpawner> {
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
          enabled: false,
        });
        continue;
      }
      // Each fetched plugin gets its own managed copy of the checkout, so
      // update and remove act on one plugin without touching another.
      const dest = path.join(pluginsDir(run.env), plugin.name);
      // A plain mkdir claims the directory: it fails if anything is there.
      yield* Effect.tryPromise({
        try: () => fs.mkdir(dest),
        catch: (error) =>
          new PluginError({
            message:
              (error as NodeJS.ErrnoException).code === 'EEXIST'
                ? `${dest} already exists but no installed plugin records it. Delete it, then install again.`
                : toErrorMessage(error),
          }),
      });
      run.created.push(dest);
      yield* fsEffect(() =>
        fs.cp(root, dest, { recursive: true, verbatimSymlinks: true }),
      );
      const pluginPath = path.join(dest, path.relative(root, candidate.dir));
      records.push({
        name: plugin.name,
        source: fetched.url,
        ...(fetched.ref ? { ref: fetched.ref } : {}),
        commit: fetched.commit,
        path: pluginPath,
        skills: plugin.skills.map((skill) => path.join(pluginPath, skill)),
        enabled: false,
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
): Effect.Effect<InstalledPlugin[], InstallFailure, ChildProcessSpawner> {
  if (origin.kind === 'local') {
    return fsEffect(() => fs.realpath(origin.path)).pipe(
      Effect.mapError(
        () =>
          new PluginRequestError({
            message: `${origin.path} is not a directory, a git URL, or github.com/<owner>/<repo>.`,
          }),
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
    fsEffect(async () => {
      await fs.mkdir(pluginsDir(run.env), { recursive: true });
      return fs.mkdtemp(path.join(pluginsDir(run.env), '.staging-'));
    }),
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
 * Install the plugin(s) `origin` offers and record them, disabled. The
 * record is written once, after every plugin is in place, and refuses a name
 * another install recorded meanwhile; a failure removes the managed
 * directories this install created and records nothing.
 */
export function installPlugins(
  origin: PluginOrigin,
  only: readonly string[],
  env: PluginEnv,
) {
  return Effect.gen(function* () {
    const { installed } = yield* readPluginState(env);
    const run: InstallRun = {
      env,
      taken: new Set(installed.map((plugin) => plugin.name)),
      created: [],
    };
    return yield* installOrigin(origin, only, run, false).pipe(
      Effect.tap((records) =>
        modifyInstalled(env, (current) => {
          const clash = records.find((record) =>
            current.some((plugin) => plugin.name === record.name),
          );
          return clash === undefined
            ? Result.succeed([[...current, ...records], undefined] as const)
            : Result.fail(nameTaken(clash.name));
        }),
      ),
      Effect.onError(() => Effect.forEach(run.created, cleanupDir)),
    );
  });
}

/**
 * Forget a plugin, and the trust given to it, and delete its managed
 * directory. A local plugin is only forgotten; its directory is the user's.
 * The record is written first, so a failed delete leaves an unreferenced
 * directory rather than a record pointing at a half-deleted one. What the
 * plugin wrote to history stays there, kept unread while it is absent.
 */
export function removePlugin(name: string, env: PluginEnv) {
  return Effect.gen(function* () {
    const plugin = yield* modifyInstalled(env, (current) =>
      Result.map(
        findInstalled(current, name),
        (found) =>
          [current.filter((entry) => entry.name !== name), found] as const,
      ),
    );
    yield* modifyTrusted(env, (current) =>
      current.filter((entry) => entry.name !== name),
    );
    if (plugin.commit !== undefined) {
      yield* removeDir(path.join(pluginsDir(env), plugin.name));
    }
    return plugin;
  });
}

/**
 * Reread a recorded plugin's manifest. Its record stands in for a manifest
 * it never had (a plugin a marketplace entry described).
 */
export function rereadPlugin(
  plugin: InstalledPlugin,
): Effect.Effect<ResolvedPlugin, PluginError> {
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
 * directory never disagree. An enabled plugin stays enabled; a new version,
 * or a change to what it runs, loads only once the user trusts it.
 */
export function updatePlugins(names: readonly string[], env: PluginEnv) {
  return Effect.gen(function* () {
    const { installed } = yield* readPluginState(env);
    const targets =
      names.length === 0
        ? installed
        : yield* Effect.forEach(names, (name) =>
            Effect.fromResult(findInstalled(installed, name)),
          );
    const updates: PluginUpdate[] = [];
    for (const plugin of targets) {
      const dir = path.join(pluginsDir(env), plugin.name);
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
      yield* modifyInstalled(env, (current) =>
        Result.map(
          findInstalled(current, plugin.name),
          (found) =>
            [
              current.map((entry) =>
                entry === found
                  ? { ...entry, ...(commit ? { commit } : {}), skills }
                  : entry,
              ),
              undefined,
            ] as const,
        ),
      );
      updates.push({ name: plugin.name, from: plugin.commit, to: commit });
    }
    return updates;
  });
}
