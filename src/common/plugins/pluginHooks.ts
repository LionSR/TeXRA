// Running an installed plugin's Claude Code command hooks, and what their
// trust covers. A hook is third-party code, so it never loads in process: it
// runs as a child process in its own process group, with a scrubbed
// environment, the workspace root as its cwd and a timeout, and the whole
// group is killed when the hook times out, its caller is interrupted, or it
// exits (`2026-09-28-code-plugins-hooks-v1.md`). What it prints is read by
// `./hookProtocol`.

// Node imports
import { hash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { Clock, Effect, Fiber, FileSystem, Option, Stream } from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import which from 'which';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isPathWithin } from '@utils/core/pathCore';
import { absentReason } from '@utils/files/fsEntryExists';

// Local imports - this module's neighbours
import { PluginError } from './pluginManifest';
import type { ConfiguredHook } from './hookConfig';
import type { HookRun } from './hookProtocol';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

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

/**
 * The shell a shell-form hook (no `args`) runs under: `/bin/sh` on macOS and
 * Linux; on Windows `bash` from PATH (Git Bash), or null when there is none,
 * and then a shell-form hook cannot run.
 */
export const hookShell = (): string | null =>
  process.platform === 'win32'
    ? which.sync('bash', { nothrow: true, path: process.env.PATH ?? '' })
    : '/bin/sh';

export const NO_SHELL =
  'cannot run here: a shell-form hook needs bash (Git Bash) on PATH on Windows';

// --------------------------------------------------------------------- trust

/** A word of a static command: only characters no shell treats specially. */
const PLAIN_WORD = /^[\w./:=+,@%-]+$/;

/** The plugin root, as a shell-form word may spell it. */
const ROOT_PLACEHOLDER = /"\$\{CLAUDE_PLUGIN_ROOT\}"|\$\{CLAUDE_PLUGIN_ROOT\}/g;

/** Programs that run code their arguments name or hold: a script path must
 *  follow them, and none of their inline-code flags may. */
const INTERPRETERS = new Set(
  'sh bash zsh dash ksh fish node nodejs deno bun python python2 python3 ruby perl php pwsh powershell osascript tclsh lua Rscript julia'.split(
    ' ',
  ),
);

/** Programs that run another program chosen at run time. */
const LAUNCHERS = new Set(
  'env xargs npx pnpx bunx uvx uv sudo doas nohup exec eval source . command time timeout nice npm pnpm yarn make git'.split(
    ' ',
  ),
);

/** Flags that hand an interpreter code inline, or a module to find. */
const INLINE_CODE = new Set(
  '-c -e -E -p -m -r -x --eval --print --command --require --import --loader -Command -EncodedCommand'.split(
    ' ',
  ),
);

/** A file a static hook runs, as its trust pins it. */
type PinnedFile =
  /** Named by path, outside the plugin (directly or through a symlink):
   *  pinned by content, or as missing. */
  | {
      readonly kind: 'external';
      readonly path: string;
      readonly sha256: string | null;
    }
  /** The program, found on PATH: pinned by path, size and date. */
  | {
      readonly kind: 'program';
      readonly path: string;
      readonly size: number;
      readonly mtimeMs: number | null;
    };

/** What trust can pin of one hook. */
type HookPin =
  /** Its program and scripts resolve without running a shell: each file
   *  outside the plugin is pinned (the plugin's own files are in its
   *  digest). */
  | { readonly kind: 'static'; readonly files: readonly PinnedFile[] }
  /** It expands, substitutes, chains, names a workspace path or hands an
   *  interpreter code: what it runs cannot be pinned, so trust covers its
   *  exact text, and only that. */
  | { readonly kind: 'dynamic'; readonly reason: string };

const dynamic = (reason: string) =>
  Effect.succeed({ kind: 'dynamic', reason } as const);

/**
 * Classify `hook` conservatively and pin what a static one runs. A shell-form
 * command is static only when every word is plain (no quoting, expansion,
 * substitution, globbing, redirection or operator), the plugin root quoted
 * or safe as spelled; an exec-form command only when no word names the
 * workspace or the plugin's data. Either way the program must be an
 * absolute path or a name on PATH, a program that launches another is
 * dynamic, and an interpreter must be given a script by absolute path and
 * no inline code. Every path word must be absolute; a path that leaves the
 * plugin, directly or through a symlink, is pinned by content.
 */
export const pinHook = Effect.fn('pluginHooks.pin')(
  function* (root: string, hook: ConfiguredHook) {
    const fs = yield* FileSystem.FileSystem;
    let words: string[];
    if (hook.args === undefined) {
      words = [];
      for (const raw of hook.command.trim().split(/\s+/)) {
        // Unquoted, the root is word-split and globbed: plain only if it is.
        const unquoted = raw
          .replaceAll('"${CLAUDE_PLUGIN_ROOT}"', '')
          .includes('${CLAUDE_PLUGIN_ROOT}');
        const marked = raw.replaceAll(ROOT_PLACEHOLDER, '\0');
        if (
          (unquoted && !PLAIN_WORD.test(root)) ||
          !PLAIN_WORD.test(marked.replaceAll('\0', 'x'))
        )
          return yield* dynamic(
            `the word ${JSON.stringify(raw)} is expanded or interpreted by the shell`,
          );
        words.push(marked.replaceAll('\0', root));
      }
    } else {
      words = [hook.command, ...hook.args];
      const named = words.find((word) =>
        /CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA/.test(word),
      );
      if (named !== undefined)
        return yield* dynamic(
          `${JSON.stringify(named)} names a workspace or data path`,
        );
      words = words.map((word) => expand(word, { pluginRoot: root }));
    }
    const [program = '', ...args] = words;
    const name = path.basename(program);
    if (LAUNCHERS.has(name))
      return yield* dynamic(`${name} runs a program chosen when it runs`);
    const inline = args.find((arg) => INLINE_CODE.has(arg));
    if (INTERPRETERS.has(name)) {
      if (inline !== undefined)
        return yield* dynamic(`${name} ${inline} runs code given inline`);
      const script = args.find((arg) => !arg.startsWith('-'));
      if (script === undefined || !path.isAbsolute(script))
        return yield* dynamic(`${name} is not given a script by absolute path`);
    }
    const realRoot = yield* fs.realPath(root);
    const files: PinnedFile[] = [];
    if (!program.includes('/') && !program.includes(path.sep)) {
      const found = which.sync(program, {
        nothrow: true,
        path: process.env.PATH ?? '',
      });
      if (found === null)
        return yield* dynamic(`${program} is not a program on PATH`);
      const info = yield* fs.stat(found);
      files.push({
        kind: 'program',
        path: found,
        size: Number(info.size),
        mtimeMs: Option.getOrUndefined(info.mtime)?.getTime() ?? null,
      });
    }
    for (const word of words) {
      if (!word.includes('/') && !word.includes(path.sep)) continue;
      if (!path.isAbsolute(word))
        return yield* dynamic(`${word} is a path relative to the workspace`);
      const real = yield* fs
        .realPath(word)
        .pipe(Effect.catchIf(absentReason, () => Effect.succeed(undefined)));
      if (real !== undefined && isPathWithin(realRoot, real)) continue;
      const info = real === undefined ? undefined : yield* fs.stat(real);
      files.push({
        kind: 'external',
        path: real ?? word,
        sha256:
          info?.type === 'File' && real !== undefined
            ? hash('sha256', yield* fs.readFile(real), 'hex')
            : null,
      });
    }
    return { kind: 'static', files } as const satisfies HookPin;
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

/** How long, once the hook exits, its pipes may take to drain: a background
 *  child still holding them is not waited for, and dies with the group. */
const STDIO_GRACE = '250 millis';

/**
 * Run one command hook with `input` on stdin, as a child process of the
 * caller's fiber: shell form (`hookShell() -c`) or exec form, in
 * `places.projectDir`, with only `PATH`, `HOME` and the `CLAUDE_*`
 * placeholders in its environment — never the process's API keys. It is
 * spawned in its own process group. Its output is read until it exits (and
 * briefly after); the scope then closes, which kills the whole group
 * (SIGTERM, then SIGKILL), as does a timeout or an interrupt, whether or not
 * the pipes closed. Never fails: a process that cannot start is an
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
  const shell = hookShell();
  if (hook.args === undefined && shell === null)
    return {
      run: { kind: 'unstartable', message: `${hook.command}: ${NO_SHELL}` },
      durationMs: 0,
    };
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: os.homedir(),
    CLAUDE_PROJECT_DIR: places.projectDir,
    CLAUDE_PLUGIN_ROOT: places.pluginRoot,
    CLAUDE_PLUGIN_DATA: places.pluginData,
  };
  const [command, args] =
    hook.args === undefined
      ? [shell ?? '/bin/sh', ['-c', hook.command]]
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
    // The first `OUTPUT_MAX` characters of each stream; the rest drains, so
    // a chatty hook never blocks on a full pipe.
    const out = { stdout: '', stderr: '' };
    const read = (stream: typeof handle.stdout, key: keyof typeof out) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            if (out[key].length < OUTPUT_MAX)
              out[key] = (out[key] + chunk).slice(0, OUTPUT_MAX);
          }),
        ),
      );
    const readers = yield* Effect.forkScoped(
      Effect.all(
        [read(handle.stdout, 'stdout'), read(handle.stderr, 'stderr')],
        {
          concurrency: 'unbounded',
        },
      ),
    );
    const exitCode = yield* handle.exitCode.pipe(
      Effect.map((code): number | null => code),
      // Killed by a signal it was not sent by us: no exit code.
      Effect.catch(() => Effect.succeed(null)),
    );
    yield* Fiber.join(readers).pipe(
      Effect.timeoutOption(STDIO_GRACE),
      Effect.ignore,
    );
    return { kind: 'exited' as const, exitCode, ...out };
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(`${hook.timeoutSeconds} seconds`),
    Effect.map(
      (ended): HookRun =>
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
