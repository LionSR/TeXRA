/**
 * How an Overleaf or ShareLaTeX clone's outcomes (`OverleafCloneOutcome`)
 * read where every host says the same thing. What a host adds is its own:
 * the terminal names its command, its destination and the next step to
 * type, the editor offers buttons.
 */
import type { OverleafCloneOutcome } from '@latex/overleafClone';
import {
  OVERLEAF_GIT_TOKEN_URL,
  OVERLEAF_TOKEN_DOCS_URL,
  type OverleafRemote,
} from '@latex/overleafProject';
import { installAdvice } from '@texra/shared/constants/latexToolchain';
import type { OsPlatform } from '@texra/shared/osPlatform';

/** The service a clone talks to, as its outcome lines name it. */
export function cloneProviderLabel(
  remote: Pick<OverleafRemote, 'isOverleaf'>,
): 'Overleaf' | 'ShareLaTeX' {
  return remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX';
}

/** What a token for `remote` looks like and where to make one; a
 *  ShareLaTeX host's tokens follow no rule this app knows. */
const tokenHint = (
  remote: Pick<OverleafRemote, 'isOverleaf'>,
): string | undefined =>
  remote.isOverleaf
    ? 'Overleaf tokens start with olp_. Generate one at Account Settings → Git Integration.'
    : undefined;

/** The token prompt and the outcome lines every host shows word for word. */
export const CLONE_COPY = Object.freeze({
  /** What the token prompt asks for. */
  tokenTitle: (remote: Pick<OverleafRemote, 'isOverleaf' | 'host'>): string =>
    remote.isOverleaf
      ? 'Overleaf Git Token'
      : `ShareLaTeX Token (${remote.host})`,
  /** The line under the prompt's title. */
  tokenPrompt: (remote: Pick<OverleafRemote, 'isOverleaf'>): string =>
    tokenHint(remote) ?? 'Enter your Git authentication token.',
  /** Where a token comes from, with its pages spelled out for a host
   *  that has no buttons; undefined where the app knows no such page. */
  tokenGuidance: (
    remote: Pick<OverleafRemote, 'isOverleaf'>,
  ): string | undefined =>
    remote.isOverleaf
      ? `${tokenHint(remote)} Create or copy a token at ${OVERLEAF_GIT_TOKEN_URL}. Instructions: ${OVERLEAF_TOKEN_DOCS_URL}`
      : undefined,
  /** What names a project to clone, where a host asks for it. */
  projectPrompt: 'Project URL, git URL, or 24-character project ID',
  /** The project named is no URL or id this app can clone. */
  invalidProject:
    'Invalid Overleaf/ShareLaTeX project: expected a project URL, a git URL or a 24-character project ID.',
  /** `InvalidToken`. */
  invalidToken: (remote: Pick<OverleafRemote, 'isOverleaf'>): string =>
    ['Invalid token format.', tokenHint(remote)]
      .filter((part) => part !== undefined)
      .join(' '),
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

/**
 * What a clone's outcome tells the user, the same on every host: a
 * sentence, the pages that help with the next step (buttons in the editor,
 * lines in the terminal) and git's own words where it failed. A host adds
 * only its own next step, and its own buttons for a missing git.
 */
interface OverleafCloneNotice {
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly links: readonly { readonly label: string; readonly url: string }[];
  /** git's message, which follows the sentence where a host shows it. */
  readonly gitError?: string;
}

const TOKEN_GUIDE_LINK = Object.freeze({
  label: 'How to get a token',
  url: OVERLEAF_TOKEN_DOCS_URL,
});

/** The notice for `outcome` of cloning `remote`. */
export function overleafCloneNotice(
  remote: OverleafRemote,
  outcome: OverleafCloneOutcome,
  platform: OsPlatform,
): OverleafCloneNotice {
  const error = (
    message: string,
    links: OverleafCloneNotice['links'] = [],
  ): OverleafCloneNotice => ({ level: 'error', message, links });
  switch (outcome._tag) {
    case 'Cloned':
      return {
        level: 'info',
        message: CLONE_COPY.cloned(remote, outcome.destination),
        links: [],
      };
    case 'Cancelled':
      return { level: 'warning', message: CLONE_COPY.cancelled, links: [] };
    case 'InvalidToken':
      // The token guide is Overleaf's; a ShareLaTeX host has its own.
      return error(
        CLONE_COPY.invalidToken(remote),
        remote.isOverleaf ? [TOKEN_GUIDE_LINK] : [],
      );
    case 'GitMissing':
      return error(CLONE_COPY.gitMissing(platform));
    case 'WorkspaceUnreadable':
      return error(CLONE_COPY.unreadable(outcome.message));
    case 'WorkspaceNotEmpty':
      return error(CLONE_COPY.notEmpty(outcome.destination));
    case 'AuthFailure':
      return {
        ...error(
          `${CLONE_COPY.authFailed} ${CLONE_COPY.authDetail(remote)}`,
          remote.isOverleaf
            ? [
                { label: 'Get new token', url: OVERLEAF_GIT_TOKEN_URL },
                TOKEN_GUIDE_LINK,
              ]
            : [],
        ),
        gitError: outcome.error,
      };
    case 'CloneFailed':
      return { ...error(CLONE_COPY.failed), gitError: outcome.error };
  }
}
