// The git steps a plugin install takes: fetch one pinned commit and check it
// out detached. git only fetches here; nothing from a plugin runs.

// Third-party imports
import { Effect } from 'effect';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';
import { machineGit } from '@utils/system/git';

// Local imports - this module's neighbours
import { PluginError } from './pluginManifest';

/** Run `git args`, answering its trimmed stdout; a failure names the command
 *  and git's stderr. */
const git = (args: readonly string[]) => {
  const commandLine = `git ${args.join(' ')}`;
  return machineGit(args).pipe(
    Effect.mapError(
      (error) =>
        new PluginError({
          message: `${commandLine} could not start: ${toErrorMessage(error)}`,
        }),
    ),
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
};

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
export const fetchPinned = Effect.fn('fetchPinned')(function* (
  dir: string,
  url: string,
  ref: string | undefined,
) {
  yield* git(['init', '--quiet', dir]);
  yield* git([
    ...['-C', dir, '-c', 'protocol.file.allow=never', 'fetch', '--quiet'],
    ...['--depth', '1', '--no-tags'],
    ...['--', url, ref ?? 'HEAD'],
  ]);
  yield* checkoutDetached(dir, 'FETCH_HEAD');
  return yield* git(['-C', dir, 'rev-parse', 'HEAD']);
});
