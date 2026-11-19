/**
 * How an Overleaf or ShareLaTeX clone's outcomes (`OverleafCloneOutcome`)
 * read where every host says the same thing. What a host adds is its own:
 * the terminal names its command, its destination and the next step to
 * type, the editor offers buttons.
 */
import type { OverleafRemote } from '@latex/overleafProject';

/** The service a clone talks to, as its outcome lines name it. */
export function cloneProviderLabel(
  remote: Pick<OverleafRemote, 'isOverleaf'>,
): 'Overleaf' | 'ShareLaTeX' {
  return remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX';
}

/** The outcome lines every host shows word for word. */
export const CLONE_COPY = Object.freeze({
  /** The token prompt was dismissed. */
  cancelled: 'Clone cancelled.',
  /** `CloneFailed`: git or the destination failed, not the credential. */
  failed: 'Clone failed. Check credentials and connection.',
  /** `AuthFailure`, before the host's next step for its credential. */
  authFailed: 'Clone failed: authentication error.',
  /** `GitMissing`, before the platform's install guide. */
  gitMissing: 'Git is not installed or is not on PATH.',
  /** The project argument names no Overleaf or ShareLaTeX project. */
  invalidProject:
    'Invalid Overleaf/ShareLaTeX project. Give a project URL, git URL, or 24-character project ID.',
});
