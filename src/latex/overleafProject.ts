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

/** A git credential ready to embed in a remote URL, plus its redaction forms. */
export interface GitCredential {
  /** Embedded in the remote URL as the userinfo component. */
  remote: string;
  /** Raw and encoded token forms to redact from logs and error messages. */
  sensitive: string[];
}

/** Build the `git:<encoded>` userinfo credential for a raw token. */
export function buildGitCredential(token: string): GitCredential {
  const encoded = encodeURIComponent(token);
  return { remote: `git:${encoded}`, sensitive: [token, encoded] };
}

/** Construct the authenticated HTTPS clone URL for a remote + credential. */
export function buildAuthenticatedRemoteUrl(
  remote: OverleafRemote,
  credential: GitCredential,
): string {
  return `https://${credential.remote}@${remote.host}${remote.path}`;
}

/** Replace every sensitive token form in `message` with `***`. */
export function redactSensitive(
  message: string,
  sensitive: readonly string[],
): string {
  let redacted = message;
  for (const s of sensitive) redacted = redacted.replaceAll(s, '***');
  return redacted;
}
