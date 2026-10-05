/**
 * Host-neutral Overleaf / ShareLaTeX git-remote domain logic.
 *
 * Pure parsing, token-spec derivation, and credential/URL construction
 * extracted from the VS Code clone command so the rules are unit-testable and
 * reusable by any host (CLI, desktop). No I/O, no `vscode`.
 */

const PROJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const GIT_URL_PATTERN =
  /^https?:\/\/(?:git@)?([^/]+)(\/git)?\/([a-f0-9]{24})$/i;
const PROJECT_URL_PATTERN = /^https?:\/\/([^/]+)\/project\/([a-f0-9]{24})\/?$/i;

export const OVERLEAF_GIT_TOKEN_URL = 'https://www.overleaf.com/user/settings';
export const OVERLEAF_TOKEN_DOCS_URL =
  'https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens';

/** A resolved Overleaf/ShareLaTeX git remote. */
export interface OverleafRemote {
  /** Git host the project clones from (e.g. `git.overleaf.com`). */
  host: string;
  /** Path component appended to the host (e.g. `/<id>` or `/git/<id>`). */
  path: string;
  /** True for overleaf.com itself; false for a self-hosted ShareLaTeX. */
  isOverleaf: boolean;
}

/**
 * Parse an Overleaf or ShareLaTeX URL into a clone target. Returns null when
 * the input matches none of the accepted shapes. Accepts:
 *   - https://git.overleaf.com/<24-char-hex>
 *   - https://sharelatex.example.com/git/<24-char-hex>
 *   - https://git@sharelatex.example.com/git/<24-char-hex>
 *   - https://www.overleaf.com/project/<24-char-hex>
 *   - https://sharelatex.example.com/project/<24-char-hex>
 *   - bare 24-char hex (assumes Overleaf)
 */
export function parseLatexGitUrl(input: string): OverleafRemote | null {
  const trimmed = input.trim();

  // Full git URL (e.g. https://git.overleaf.com/<id>)
  const match = GIT_URL_PATTERN.exec(trimmed);
  if (match) {
    const [, host, hasGit, id] = match;
    return {
      host,
      path: hasGit ? `/git/${id}` : `/${id}`,
      isOverleaf: host === 'git.overleaf.com',
    };
  }

  // Project URL (e.g. https://www.overleaf.com/project/<id> or
  // https://sharelatex.example.com/project/<id>)
  const projectMatch = PROJECT_URL_PATTERN.exec(trimmed);
  if (projectMatch) {
    const [, rawHost, id] = projectMatch;
    const host = rawHost.replace(/^www\./, '');
    const isOverleaf = host === 'overleaf.com';
    return {
      host: isOverleaf ? 'git.overleaf.com' : host,
      path: isOverleaf ? `/${id}` : `/git/${id}`,
      isOverleaf,
    };
  }

  // Bare project ID -> Overleaf
  if (PROJECT_ID_PATTERN.test(trimmed)) {
    return { host: 'git.overleaf.com', path: `/${trimmed}`, isOverleaf: true };
  }

  return null;
}

/** How a host should prompt for and validate the project's git token. */
export interface OverleafTokenSpec {
  /** Secret-storage key the token is cached under. */
  tokenKey: string;
  /** Prompt title shown when requesting the token. */
  tokenTitle: string;
  /** Optional format check; rejects obviously-wrong tokens before cloning. */
  tokenValidator?: (token: string) => boolean;
  /** Optional hint copy explaining where to obtain a token. */
  tokenHint?: string;
}

/** Derive the per-host token prompt/validation rules for a remote. */
export function overleafTokenSpec(remote: OverleafRemote): OverleafTokenSpec {
  if (remote.isOverleaf) {
    return {
      tokenKey: 'overleaf.gitToken',
      tokenTitle: 'Overleaf Git Token',
      tokenValidator: (t) => t.startsWith('olp_'),
      tokenHint:
        'Overleaf tokens start with olp_. Generate one at Account Settings → Git Integration.',
    };
  }
  return {
    tokenKey: `sharelatex.${remote.host}.token`,
    tokenTitle: `ShareLaTeX Token (${remote.host})`,
  };
}

/**
 * Environment variable the per-invocation credential helper reads the token
 * from. Set only on the `git` process that needs it.
 */
const GIT_TOKEN_ENV = 'TEXRA_GIT_TOKEN';

/**
 * A credential helper that answers git's `get` with the token in
 * {@link GIT_TOKEN_ENV}. `printf`, not `echo`: some shells' `echo` rewrites
 * backslashes, and a ShareLaTeX password may hold one.
 */
const TOKEN_HELPER = `!f() { test "$1" = get && printf 'password=%s\\n' "$${GIT_TOKEN_ENV}"; }; f`;

/** A `git clone` of an Overleaf/ShareLaTeX project that authenticates with a token. */
export interface OverleafGitClone {
  /**
   * `git` arguments. The remote URL carries no credential, so the clone's
   * `.git/config` holds none; the configured credential helpers are cleared
   * for this one invocation and replaced by {@link TOKEN_HELPER}.
   */
  readonly args: readonly string[];
  /** Environment additions for that `git` process: the token for the helper. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Input for `git credential approve` once the clone succeeds, which hands
   * the token to the user's own credential helper (a keychain, the Git
   * credential manager) so a later pull or push authenticates. With no
   * helper configured git asks for the token instead.
   */
  readonly approval: string;
}

/** The clone of `remote` into the current directory, authenticated with `token`. */
export function overleafGitClone(
  remote: OverleafRemote,
  token: string,
): OverleafGitClone {
  return {
    args: [
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=${TOKEN_HELPER}`,
      'clone',
      `https://git@${remote.host}${remote.path}`,
      '.',
    ],
    env: { [GIT_TOKEN_ENV]: token },
    approval: `protocol=https\nhost=${remote.host}\nusername=git\npassword=${token}\n\n`,
  };
}
