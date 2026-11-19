/**
 * How an Overleaf or ShareLaTeX clone's outcomes (`OverleafCloneOutcome`)
 * read where every host says the same thing. What a host adds is its own:
 * the terminal names its command, its destination and the next step to
 * type, the editor offers buttons.
 */
import type { OverleafRemote } from '@latex/overleafProject';
import { installAdvice } from '@texra/shared/constants/latexToolchain';
import type { OsPlatform } from '@texra/shared/osPlatform';

/** The service a clone talks to, as its outcome lines name it. */
export function cloneProviderLabel(
  remote: Pick<OverleafRemote, 'isOverleaf'>,
): 'Overleaf' | 'ShareLaTeX' {
  return remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX';
}

/** The outcome lines every host shows word for word. */
export const CLONE_COPY = Object.freeze({
  /** `Cloned`. */
  cloned: (
    remote: Pick<OverleafRemote, 'isOverleaf'>,
    destination: string,
  ): string =>
    `${cloneProviderLabel(remote)} project cloned into ${destination}.`,
  /** `GitMissing`, with the platform's install guide. */
  gitMissing: (platform: OsPlatform): string =>
    `Git is not installed or is not on PATH.\n\n${
      installAdvice('Git', ['git'], platform).guide
    }`,
  /** `WorkspaceUnreadable`, with the operating system's message. */
  unreadable: (message: string): string =>
    `Cannot read the destination folder: ${message}`,
  /** `WorkspaceNotEmpty`, before the host's next step. */
  notEmpty: (destination: string): string =>
    `The destination folder ${destination} is not empty.`,
  /** `AuthFailure`: which credential to check, after `authFailed`. */
  authDetail: (remote: Pick<OverleafRemote, 'isOverleaf'>): string =>
    remote.isOverleaf
      ? 'The Overleaf git token may be invalid or expired.'
      : 'Check the ShareLaTeX credentials for this host.',
  /** The token prompt was dismissed. */
  cancelled: 'Clone cancelled.',
  /** `CloneFailed`: git or the destination failed, not the credential. */
  failed: 'Clone failed. Check credentials and connection.',
  /** `AuthFailure`, before the host's next step for its credential. */
  authFailed: 'Clone failed: authentication error.',
});
