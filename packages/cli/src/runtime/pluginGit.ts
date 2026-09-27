// The git steps `texra plugin` takes: fetch one pinned commit and check it
// out detached. git only fetches here; nothing from a plugin runs.

import { Effect, Stream } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';

import { toErrorMessage } from '@utils/errors/errorMessage';
import { makeMachineGitEnv } from '@utils/system/gitEnv';

import { PluginError } from './pluginManifest';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

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
export function checkoutDetached(dir: string, rev: string) {
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
export function fetchPinned(dir: string, url: string, ref: string | undefined) {
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
