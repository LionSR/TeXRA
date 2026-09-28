// Running an installed plugin's Claude Code command hooks, and what their
// trust covers. A hook is third-party code, so it never loads in process: it
// runs as a child process in its own process group, with a scrubbed
// environment, the workspace root as its cwd and a timeout, and the whole
// group is killed when the hook times out or its caller is interrupted
// (`2026-09-28-code-plugins-hooks-v1.md`). What it prints is read by
// `./hookProtocol`.

// Node imports
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { Clock, Effect, FileSystem, Option, Stream } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import which from 'which';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';
import { absentReason } from '@utils/files/fsEntryExists';

// Local imports - this module's neighbours
import { escapes, PluginError } from './pluginManifest';
import type { ConfiguredHook } from './hookConfig';
import type { HookRun } from './hookProtocol';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

/** What a hook's placeholders and `CLAUDE_*` variables name when it runs. */
interface HookPlaces {
  /** The plugin directory: `CLAUDE_PLUGIN_ROOT`. */
  readonly pluginRoot: string;
  /** The workspace root, the hook's cwd: `CLAUDE_PROJECT_DIR`. */
  readonly projectDir: string;
  /** The plugin's persistent data directory: `CLAUDE_PLUGIN_DATA`. */
  readonly pluginData: string;
}

const PLACEHOLDERS = [
  ['CLAUDE_PLUGIN_ROOT', 'pluginRoot'],
  ['CLAUDE_PROJECT_DIR', 'projectDir'],
  ['CLAUDE_PLUGIN_DATA', 'pluginData'],
] as const;

/** Substitute `${NAME}` and `$NAME` for each placeholder that has a value. */
const expand = (value: string, places: Partial<HookPlaces>) =>
  PLACEHOLDERS.reduce((text, [name, key]) => {
    const place = places[key];
    return place === undefined
      ? text
      : text.replaceAll(`\${${name}}`, place).replaceAll(`$${name}`, place);
  }, value);

/** The plugin data directory TeXRA keeps for `name`. */
export const pluginDataDir = (globalStorage: string, name: string) =>
  path.join(globalStorage, 'plugin-data', name);

// --------------------------------------------------------------------- trust

/** A shell command's words, quotes removed, with each word that starts a
 *  command (the first, and the first after `&&`, `||`, `|` or `;`) marked. */
function shellWords(command: string) {
  const words: { text: string; starts: boolean }[] = [];
  let starts = true;
  for (const match of command.matchAll(
    /(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/g,
  )) {
    const raw = match[0];
    if (['&&', '||', '|', ';'].includes(raw)) {
      starts = true;
      continue;
    }
    words.push({
      text: raw.replaceAll(/["']/g, ''),
      starts,
    });
    starts = false;
  }
  return words;
}

/** A file a hook names, as its trust records it. */
type HookFile =
  /** Outside the plugin, directly or through a symlink: its content is
   *  hashed into the trust digest, so an edit asks again. */
  | {
      readonly kind: 'external';
      readonly path: string;
      readonly sha256: string;
    }
  /** A program found on PATH: pinned by path, size and date. */
  | {
      readonly kind: 'program';
      readonly path: string;
      readonly size: number;
      readonly mtimeMs: number | null;
    }
  /** A workspace path (`$CLAUDE_PROJECT_DIR`, or relative to the cwd):
   *  read when the hook runs, not covered by trust. */
  | { readonly kind: 'workspace'; readonly path: string };

/**
 * The files `hook` names outside the plugin at `root`: each word of its
 * command (exec form: the command and its arguments) that is a path, after
 * `${CLAUDE_PLUGIN_ROOT}` is expanded, resolved through symlinks. A path
 * inside the plugin is covered by the plugin's own digest and not listed. A
 * word that starts a command and names no path is a program looked up on
 * PATH. A path that does not exist names nothing (the hook fails loudly when
 * it runs).
 */
export const hookFiles = Effect.fn('pluginHooks.files')(
  function* (root: string, hook: ConfiguredHook) {
    const fs = yield* FileSystem.FileSystem;
    const realRoot = yield* fs.realPath(root);
    const words =
      hook.args === undefined
        ? shellWords(hook.command)
        : [
            { text: hook.command, starts: true },
            ...hook.args.map((text) => ({ text, starts: false })),
          ];
    const found: HookFile[] = [];
    for (const word of words) {
      if (/CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA/.test(word.text)) {
        found.push({ kind: 'workspace', path: word.text });
        continue;
      }
      const text = expand(word.text, { pluginRoot: root });
      if (!text.includes('/')) {
        const program = word.starts
          ? which.sync(text, { nothrow: true, path: process.env.PATH ?? '' })
          : null;
        if (program === null) continue;
        const info = yield* fs.stat(program);
        found.push({
          kind: 'program',
          path: program,
          size: Number(info.size),
          mtimeMs: Option.getOrUndefined(info.mtime)?.getTime() ?? null,
        });
        continue;
      }
      if (!path.isAbsolute(text)) {
        found.push({ kind: 'workspace', path: text });
        continue;
      }
      const real = yield* fs
        .realPath(text)
        .pipe(Effect.catchIf(absentReason, () => Effect.succeed(undefined)));
      if (real === undefined || !escapes(path.relative(realRoot, real)))
        continue;
      const info = yield* fs.stat(real);
      if (info.type !== 'File') continue;
      found.push({
        kind: 'external',
        path: real,
        sha256: createHash('sha256')
          .update(yield* fs.readFile(real))
          .digest('hex'),
      });
    }
    return found;
  },
  Effect.mapError(
    (error) =>
      new PluginError({
        message: `Could not read what a plugin's hook runs: ${error.message}`,
      }),
  ),
);

// ----------------------------------------------------------------------- run

/** The reference's cap on what a hook adds to the model's context. */
const OUTPUT_MAX = 10_000;

/** How long a killed hook's process group has before SIGKILL. */
const FORCE_KILL_AFTER = '2 seconds';

/** Read a stream as text, keeping the first `OUTPUT_MAX` characters and
 *  draining the rest, so a chatty hook never blocks on a full pipe. */
const capped = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => '',
      (text: string, chunk: string) =>
        text.length >= OUTPUT_MAX ? text : (text + chunk).slice(0, OUTPUT_MAX),
    ),
  );

/**
 * Run one command hook with `input` on stdin, as a child process of the
 * caller's fiber: shell form (`sh -c`) or exec form, in `places.projectDir`,
 * with only `PATH`, `HOME` and the `CLAUDE_*` placeholders in its
 * environment — never the process's API keys. It is spawned in its own
 * process group, and a timeout or an interrupt kills the whole group
 * (SIGTERM, then SIGKILL). Never fails: a process that cannot start is an
 * `unstartable` run.
 */
export const runHook = Effect.fn('pluginHooks.run')(function* (
  hook: ConfiguredHook,
  input: string,
  places: HookPlaces,
): Effect.fn.Return<
  { readonly run: HookRun; readonly durationMs: number },
  never,
  ChildProcessSpawner | FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const started = yield* Clock.currentTimeMillis;
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: os.homedir(),
    CLAUDE_PROJECT_DIR: places.projectDir,
    CLAUDE_PLUGIN_ROOT: places.pluginRoot,
    CLAUDE_PLUGIN_DATA: places.pluginData,
  };
  const [command, args] =
    hook.args === undefined
      ? ['/bin/sh', ['-c', hook.command]]
      : [expand(hook.command, places), hook.args.map((a) => expand(a, places))];
  const run: HookRun = yield* Effect.gen(function* () {
    yield* fs.makeDirectory(places.pluginData, { recursive: true });
    const handle = yield* ChildProcess.make(command, args, {
      cwd: places.projectDir,
      env,
      extendEnv: false,
      stdin: Stream.make(new TextEncoder().encode(input)),
      detached: true,
      forceKillAfter: FORCE_KILL_AFTER,
    });
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        capped(handle.stdout),
        capped(handle.stderr),
        handle.exitCode.pipe(
          Effect.map((code): number | null => code),
          // Killed by a signal it was not sent by us: no exit code.
          Effect.catch(() => Effect.succeed(null)),
        ),
      ],
      { concurrency: 'unbounded' },
    );
    return { kind: 'exited' as const, exitCode, stdout, stderr };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(`${hook.timeoutSeconds} seconds`),
    Effect.map((ended): HookRun =>
      Option.getOrElse(ended, () => ({
        kind: 'timeout' as const,
        stdout: '',
        stderr: '',
      })),
    ),
    Effect.catch((error) =>
      Effect.succeed({
        kind: 'unstartable' as const,
        message: `${hook.args === undefined ? hook.command : command}: ${toErrorMessage(error)}`,
      }),
    ),
  );
  const durationMs = (yield* Clock.currentTimeMillis) - started;
  return { run, durationMs };
});
