/**
 * Host-neutral Overleaf / ShareLaTeX clone workflow: token caching and
 * validation, clone-precondition checks, and clone execution with
 * auth-failure handling (clears the bad token and reports the failure; does
 * not retry the clone itself). Reaches every side effect (secret storage,
 * prompts, the actual `git clone`, and user-facing messages) through
 * `ports`, so the decision logic is unit-testable and reusable by any host —
 * not just the VS Code command it was extracted from.
 *
 * Every port is an Effect: the workflow is one program the host runs at its
 * own entry, so a cancelled clone interrupts the prompt and the subprocess
 * instead of running them out.
 */

import { Effect } from 'effect';

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
  getStoredToken(key: string): Effect.Effect<string | undefined>;
  deleteStoredToken(key: string): Effect.Effect<void>;
  storeToken(key: string, token: string): Effect.Effect<void>;
  /**
   * Prompt for a new token; null when the user cancels. Fails when the host
   * cannot prompt at all (a non-interactive CLI run, say) — that is a usage
   * error for the caller to report, not a cancelled clone.
   */
  promptToken(spec: OverleafTokenSpec): Effect.Effect<string | null, Error>;
  /** Surface an invalid-token-format error for the given spec. */
  showInvalidToken(
    spec: OverleafTokenSpec,
    message: string,
  ): Effect.Effect<void>;

  isGitAvailable(): Effect.Effect<boolean>;
  /** `git` isn't on PATH — surface install guidance. */
  showGitMissing(): Effect.Effect<void>;
  /** Fails when the directory can't be read at all. */
  listWorkspaceEntries(
    workspacePath: string,
  ): Effect.Effect<Iterable<string>, Error>;
  showWorkspaceUnreadable(error: unknown): Effect.Effect<void>;
  showWorkspaceNotEmpty(): Effect.Effect<void>;

  /** Fails when `git clone` does. */
  runClone(
    remoteUrl: string,
    workspacePath: string,
  ): Effect.Effect<void, Error>;
  showCloneSucceeded(label: string): Effect.Effect<void>;
  /** The clone failed for what looks like an auth reason (bad/expired token). */
  showAuthFailure(remote: OverleafRemote): Effect.Effect<void>;
  showCloneFailed(message: string): Effect.Effect<void>;
  logCloneError(message: string): Effect.Effect<void>;
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

const resolveOverleafToken = Effect.fn('overleaf.resolveToken')(function* (
  remote: OverleafRemote,
  ports: OverleafCloneWorkflowPorts,
): Effect.fn.Return<TokenResolution, Error> {
  const spec = overleafTokenSpec(remote);
  const isValid = (t: string): boolean => spec.tokenValidator?.(t) ?? true;

  const stored = (yield* ports.getStoredToken(spec.tokenKey))?.trim() ?? '';
  if (stored && isValid(stored)) {
    return { status: 'ready', credential: buildGitCredential(stored) };
  }
  if (stored) yield* ports.deleteStoredToken(spec.tokenKey);

  const input = yield* ports.promptToken(spec);
  if (!input) return { status: 'cancelled' };

  if (!isValid(input)) {
    const message = spec.tokenHint
      ? `Invalid token format. ${spec.tokenHint}`
      : 'Invalid token format.';
    yield* ports.showInvalidToken(spec, message);
    return { status: 'invalidToken' };
  }

  yield* ports.storeToken(spec.tokenKey, input);
  return { status: 'ready', credential: buildGitCredential(input) };
});

const checkOverleafClonePreconditions = Effect.fn(
  'overleaf.checkClonePreconditions',
)(function* (
  workspacePath: string,
  ports: OverleafCloneWorkflowPorts,
): Effect.fn.Return<ClonePreconditionFailure | null, never> {
  if (!(yield* ports.isGitAvailable())) {
    yield* ports.showGitMissing();
    return { status: 'gitMissing' };
  }

  const entries = yield* ports
    .listWorkspaceEntries(workspacePath)
    .pipe(
      Effect.catch((error) =>
        ports
          .showWorkspaceUnreadable(error)
          .pipe(Effect.as<Iterable<string> | null>(null)),
      ),
    );
  if (entries === null) return { status: 'workspaceUnreadable' };

  if ([...entries].some((name) => !IGNORED_CLONE_FILES.has(name))) {
    yield* ports.showWorkspaceNotEmpty();
    return { status: 'workspaceNotEmpty' };
  }

  return null;
});

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
export const cloneOverleafProject = Effect.fn('overleaf.cloneProject')(
  function* (
    remote: OverleafRemote,
    workspacePath: string,
    ports: OverleafCloneWorkflowPorts,
  ): Effect.fn.Return<OverleafCloneOutcome, Error> {
    const preconditionFailure = yield* checkOverleafClonePreconditions(
      workspacePath,
      ports,
    );
    if (preconditionFailure) return preconditionFailure;

    const token = yield* resolveOverleafToken(remote, ports);
    if (token.status !== 'ready') return token;

    const remoteUrl = buildAuthenticatedRemoteUrl(remote, token.credential);
    const label = remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX';

    return yield* ports.runClone(remoteUrl, workspacePath).pipe(
      Effect.flatMap(() =>
        ports
          .showCloneSucceeded(label)
          .pipe(Effect.as<OverleafCloneOutcome>({ status: 'success' })),
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const authError = isCloneAuthError(error);
          if (authError) {
            yield* ports.deleteStoredToken(overleafTokenSpec(remote).tokenKey);
            yield* ports.showAuthFailure(remote);
          } else {
            yield* ports.showCloneFailed(
              'Clone failed. Check credentials and connection.',
            );
          }
          yield* ports.logCloneError(
            redactSensitive(error.message, token.credential.sensitive),
          );
          return {
            status: authError ? 'authFailure' : 'cloneFailed',
          } satisfies OverleafCloneOutcome;
        }),
      ),
    );
  },
);
