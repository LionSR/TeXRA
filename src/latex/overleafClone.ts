/**
 * Host-neutral Overleaf / ShareLaTeX clone workflow: token caching and
 * validation, clone-precondition checks, and clone execution with
 * auth-failure retry. Reaches every side effect (secret storage, prompts,
 * the actual `git clone`, and user-facing messages) through `ports`, so the
 * decision logic is unit-testable and reusable by any host — not just the
 * VS Code command it was extracted from.
 */

import {
  buildAuthenticatedRemoteUrl,
  buildGitCredential,
  overleafTokenSpec,
  redactSensitive,
  type GitCredential,
  type OverleafRemote,
  type OverleafTokenSpec,
} from '@latex/overleafProject';

/** Files ignored when deciding whether a workspace is "empty enough" to clone into. */
const IGNORED_CLONE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export interface OverleafCloneWorkflowPorts {
  getStoredToken(key: string): Promise<string | undefined>;
  deleteStoredToken(key: string): Promise<void>;
  storeToken(key: string, token: string): Promise<void>;
  /** Prompt for a new token; null when the user cancels. */
  promptToken(spec: OverleafTokenSpec): Promise<string | null>;
  /** Surface an invalid-token-format error for the given spec. */
  showInvalidToken(spec: OverleafTokenSpec, message: string): Promise<void>;

  isGitAvailable(): boolean;
  /** `git` isn't on PATH — surface install guidance. */
  showGitMissing(): Promise<void>;
  listWorkspaceEntries(workspacePath: string): Promise<Iterable<string>>;
  showWorkspaceUnreadable(error: unknown): void;
  showWorkspaceNotEmpty(): void;

  runClone(remoteUrl: string, workspacePath: string): Promise<void>;
  showCloneSucceeded(label: string): void;
  /** The clone failed for what looks like an auth reason (bad/expired token). */
  showAuthFailure(remote: OverleafRemote): Promise<void>;
  showCloneFailed(message: string): void;
  logCloneError(message: string): void;
}

type OverleafCloneOutcome =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'invalidToken' }
  | { status: 'gitMissing' }
  | { status: 'workspaceUnreadable' }
  | { status: 'workspaceNotEmpty' }
  | { status: 'authFailure' }
  | { status: 'cloneFailed' };

type TokenResolution =
  | { status: 'ready'; credential: GitCredential }
  | { status: 'cancelled' }
  | { status: 'invalidToken' };

type ClonePreconditionFailure =
  | { status: 'gitMissing' }
  | { status: 'workspaceUnreadable' }
  | { status: 'workspaceNotEmpty' };

async function resolveOverleafToken(
  remote: OverleafRemote,
  ports: OverleafCloneWorkflowPorts,
): Promise<TokenResolution> {
  const spec = overleafTokenSpec(remote);
  const isValid = (t: string): boolean => spec.tokenValidator?.(t) ?? true;

  const stored = (await ports.getStoredToken(spec.tokenKey))?.trim() ?? '';
  if (stored && isValid(stored)) {
    return { status: 'ready', credential: buildGitCredential(stored) };
  }
  if (stored) await ports.deleteStoredToken(spec.tokenKey);

  const input = await ports.promptToken(spec);
  if (!input) return { status: 'cancelled' };

  if (!isValid(input)) {
    const message = spec.tokenHint
      ? `Invalid token format. ${spec.tokenHint}`
      : 'Invalid token format.';
    await ports.showInvalidToken(spec, message);
    return { status: 'invalidToken' };
  }

  await ports.storeToken(spec.tokenKey, input);
  return { status: 'ready', credential: buildGitCredential(input) };
}

async function checkOverleafClonePreconditions(
  workspacePath: string,
  ports: OverleafCloneWorkflowPorts,
): Promise<ClonePreconditionFailure | null> {
  if (!ports.isGitAvailable()) {
    await ports.showGitMissing();
    return { status: 'gitMissing' };
  }

  let entries: Iterable<string>;
  try {
    entries = await ports.listWorkspaceEntries(workspacePath);
  } catch (e) {
    ports.showWorkspaceUnreadable(e);
    return { status: 'workspaceUnreadable' };
  }

  if ([...entries].some((name) => !IGNORED_CLONE_FILES.has(name))) {
    ports.showWorkspaceNotEmpty();
    return { status: 'workspaceNotEmpty' };
  }

  return null;
}

function isCloneAuthError(e: unknown): boolean {
  return (
    e instanceof Error && /auth|401|403|fatal: could not read/i.test(e.message)
  );
}

/**
 * Resolve credentials, verify clone preconditions, and clone an
 * Overleaf/ShareLaTeX project into an empty workspace. `remote` must already
 * be a parsed, validated target (see `parseLatexGitUrl`) — URL parsing and
 * workspace-selection stay with the caller, since those are trivial,
 * host-specific guard clauses rather than shared workflow logic.
 */
export async function cloneOverleafProject(
  remote: OverleafRemote,
  workspacePath: string,
  ports: OverleafCloneWorkflowPorts,
): Promise<OverleafCloneOutcome> {
  const preconditionFailure = await checkOverleafClonePreconditions(
    workspacePath,
    ports,
  );
  if (preconditionFailure) return preconditionFailure;

  const token = await resolveOverleafToken(remote, ports);
  if (token.status !== 'ready') return token;

  const remoteUrl = buildAuthenticatedRemoteUrl(remote, token.credential);
  const label = remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX';

  try {
    await ports.runClone(remoteUrl, workspacePath);
    ports.showCloneSucceeded(label);
    return { status: 'success' };
  } catch (e) {
    const authError = isCloneAuthError(e);
    if (authError) {
      await ports.deleteStoredToken(overleafTokenSpec(remote).tokenKey);
      await ports.showAuthFailure(remote);
    } else {
      ports.showCloneFailed('Clone failed. Check credentials and connection.');
    }
    if (e instanceof Error) {
      ports.logCloneError(
        redactSensitive(e.message, token.credential.sensitive),
      );
    }
    return { status: authError ? 'authFailure' : 'cloneFailed' };
  }
}
