/**
 * Host-neutral Overleaf / ShareLaTeX clone workflow: token caching and
 * validation, clone-precondition checks, creating the destination, and clone
 * execution with auth-failure handling (clears the bad token and reports the
 * failure; does not retry the clone itself). It reaches secret storage, the
 * token prompt and the host's progress display through `ports`, the
 * destination and `git clone` through the process's filesystem and spawner,
 * and returns one {@link OverleafCloneOutcome}; each host turns that outcome
 * into words.
 *
 * Every port is an Effect: the workflow is one program the host runs at its
 * own entry, so a cancelled clone interrupts the prompt and the subprocess
 * instead of running them out.
 */

import { Effect, FileSystem, Schema } from 'effect';
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import { withLogChannel } from '@texra-ai/harness/plugins';
import { executeCommand, machineGit } from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';
import {
  overleafGitClone,
  overleafTokenSpec,
  type OverleafGitClone,
  type OverleafRemote,
  type OverleafTokenSpec,
} from '@latex/overleafProject';
import type { CredentialStore } from '@texra-ai/llm';
import type { PlatformError } from 'effect/PlatformError';

/** What the clone workflow runs on: git, and the filesystem for the
 *  destination probe and its creation. */
type CloneServices = ChildProcessSpawner | FileSystem.FileSystem;

/** Files ignored when deciding whether a workspace is "empty enough" to clone into. */
const IGNORED_CLONE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export interface OverleafCloneWorkflowPorts {
  /** Where the clone token is cached, under its spec's `tokenKey`. */
  readonly secrets: CredentialStore;
  /**
   * Prompt for a new token; null when the user cancels. Fails when the host
   * cannot prompt at all (a non-interactive CLI run, say) — that is a usage
   * error for the caller to report, not a cancelled clone.
   */
  promptToken(spec: OverleafTokenSpec): Effect.Effect<string | null, Error>;
  /** Show `clone` (the `git clone` run) as one long-running step, where the
   *  host has a progress display; a host without one returns it as is. */
  showProgress<A, E, R>(clone: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}

/**
 * How a clone ended. `AuthFailure` (git rejected the token, now cleared) and
 * `CloneFailed` carry git's message, which cannot hold the token: it travels
 * in no argument or URL. A `CloneFailed` before git ran (the destination
 * could not be created) and `WorkspaceUnreadable` carry the operating
 * system's message, which names the path.
 */
export type OverleafCloneOutcome =
  | { readonly _tag: 'Cloned'; readonly destination: string }
  | { readonly _tag: 'Cancelled' }
  | {
      readonly _tag: 'InvalidToken';
      readonly spec: OverleafTokenSpec;
      readonly message: string;
    }
  | { readonly _tag: 'GitMissing' }
  | { readonly _tag: 'WorkspaceUnreadable'; readonly message: string }
  | { readonly _tag: 'WorkspaceNotEmpty' }
  | { readonly _tag: 'AuthFailure'; readonly error: string }
  | { readonly _tag: 'CloneFailed'; readonly error: string };

type TokenResolution =
  | { readonly _tag: 'Ready'; readonly token: string }
  | Extract<OverleafCloneOutcome, { _tag: 'Cancelled' | 'InvalidToken' }>;

const resolveOverleafToken = Effect.fn('overleaf.resolveToken')(function* (
  remote: OverleafRemote,
  ports: OverleafCloneWorkflowPorts,
): Effect.fn.Return<TokenResolution, Error> {
  const spec = overleafTokenSpec(remote);
  const isValid = (t: string): boolean => spec.tokenValidator?.(t) ?? true;

  const stored = (yield* ports.secrets.get(spec.tokenKey))?.trim() ?? '';
  if (stored && isValid(stored)) {
    return { _tag: 'Ready', token: stored };
  }
  if (stored) yield* ports.secrets.delete(spec.tokenKey);

  const input = yield* ports.promptToken(spec);
  if (!input) return { _tag: 'Cancelled' };

  if (!isValid(input)) {
    const message = spec.tokenHint
      ? `Invalid token format. ${spec.tokenHint}`
      : 'Invalid token format.';
    return { _tag: 'InvalidToken', spec, message };
  }

  yield* ports.secrets.set(spec.tokenKey, input);
  return { _tag: 'Ready', token: input };
});

/** What the operating system said about a failed filesystem call: Node's
 *  own message ("EACCES: permission denied, mkdir '…'"), which names the
 *  path and the reason, rather than the wrapper's. */
const systemMessage = (error: PlatformError): string =>
  ensureError(error.reason.cause ?? error).message;

const checkOverleafClonePreconditions = Effect.fn(
  'overleaf.checkClonePreconditions',
)(function* (
  workspaceRoot: string,
): Effect.fn.Return<OverleafCloneOutcome | null, never, CloneServices> {
  // Directory-independent: the clone target may not exist yet.
  const gitVersion = yield* executeCommand(['git', '--version'], {
    cwd: process.cwd(),
    quiet: true,
  });
  if (!gitVersion.success) return { _tag: 'GitMissing' };

  const fs = yield* FileSystem.FileSystem;
  const entries = yield* Effect.result(
    fs.readDirectory(workspaceRoot).pipe(
      // A destination that does not exist yet is an empty destination, not
      // an unreadable one: the clone creates it. Only `NotFound` counts, not
      // all of `meansAbsent`: a path under a regular file (ENOTDIR) cannot
      // be created, so it stays unreadable and stops the clone before the
      // token prompt.
      Effect.catchReason('PlatformError', 'NotFound', () =>
        Effect.succeed<string[]>([]),
      ),
    ),
  );
  if (entries._tag === 'Failure') {
    return {
      _tag: 'WorkspaceUnreadable',
      message: systemMessage(entries.failure),
    };
  }
  if (entries.success.some((name) => !IGNORED_CLONE_FILES.has(name))) {
    return { _tag: 'WorkspaceNotEmpty' };
  }

  return null;
});

/**
 * `git clone` ended without a clone. `message` is git's own stderr, the exit
 * code when it printed none, or, when git could not be run at all, the
 * PlatformError's own message after a fixed prefix (for a spawn failure,
 * `Tag: Module.method (pathOrDescriptor)`, with a description only when the
 * spawner supplies one).
 */
class GitCloneFailed extends Schema.TaggedError<GitCloneFailed>()(
  'GitCloneFailed',
  {
    exitCode: Schema.UndefinedOr(Schema.Number),
    message: Schema.String,
  },
) {}

/**
 * git translates its messages; the clone runs in the C locale so its stderr
 * carries the English wording {@link GIT_AUTH_FAILURE} matches.
 */
const GIT_C_LOCALE = { LC_ALL: 'C', LANGUAGE: 'C' } as const;

/**
 * Run `clone` in the existing directory `into`, then `git credential
 * approve` with its `approval`. The approval only offers the token to the
 * user's credential helper, so its failure is logged at warn rather than
 * failing a clone that succeeded.
 */
const gitClone = Effect.fn('overleafClone.gitClone')(function* (
  clone: OverleafGitClone,
  into: string,
): Effect.fn.Return<void, GitCloneFailed, ChildProcessSpawner> {
  const cloned = yield* machineGit(clone.args, {
    cwd: into,
    env: { ...clone.env, ...GIT_C_LOCALE },
  }).pipe(
    Effect.mapError(
      (error: PlatformError) =>
        new GitCloneFailed({
          exitCode: undefined,
          message: `git clone did not complete: ${error.message}`,
        }),
    ),
  );
  if (cloned.code !== 0) {
    return yield* new GitCloneFailed({
      exitCode: cloned.code,
      message: cloned.stderr || `git clone exited with code ${cloned.code}`,
    });
  }
  const approved = yield* Effect.result(
    machineGit(['credential', 'approve'], {
      cwd: into,
      input: clone.approval,
    }),
  );
  let approveFailure: string | undefined;
  if (approved._tag === 'Failure') {
    approveFailure = approved.failure.message;
  } else if (approved.success.code !== 0) {
    approveFailure = `exit ${approved.success.code}: ${approved.success.stderr}`;
  }
  if (approveFailure !== undefined) {
    yield* Effect.logWarning(
      `git credential approve failed (${approveFailure}). The clone succeeded; git will ask for the token on the next pull or push.`,
    ).pipe(withLogChannel('overleafClone'));
  }
});

/** git's own wording for a rejected credential; never URL or path text. */
const GIT_AUTH_FAILURE =
  /Authentication failed for|could not read (Username|Password) for|The requested URL returned error: 40[13]/;

/**
 * Only git exiting 128 with its own credential-rejection wording counts as an
 * auth failure. A network failure is a plain clone failure, so the stored
 * token survives.
 */
const isCloneAuthError = (error: GitCloneFailed): boolean =>
  error.exitCode === 128 && GIT_AUTH_FAILURE.test(error.message);

/**
 * Resolve credentials, verify clone preconditions, create the destination and
 * clone an Overleaf/ShareLaTeX project into it. `remote` must already be a
 * parsed, validated target (see `parseLatexGitUrl`) — URL parsing and
 * workspace-selection stay with the caller, since those are trivial,
 * host-specific guard clauses rather than shared workflow logic.
 */
export const cloneOverleafProject = Effect.fn('overleaf.cloneProject')(
  function* (
    remote: OverleafRemote,
    workspaceRoot: string,
    ports: OverleafCloneWorkflowPorts,
  ): Effect.fn.Return<OverleafCloneOutcome, Error, CloneServices> {
    const preconditionFailure =
      yield* checkOverleafClonePreconditions(workspaceRoot);
    if (preconditionFailure) return preconditionFailure;

    const token = yield* resolveOverleafToken(remote, ports);
    if (token._tag !== 'Ready') return token;

    // A destination that cannot be created is a failed clone before git ran,
    // never an auth failure. The canonical path is the one git clones into
    // and the clone reports.
    const fs = yield* FileSystem.FileSystem;
    const destination = yield* Effect.result(
      fs
        .makeDirectory(workspaceRoot, { recursive: true })
        .pipe(Effect.andThen(fs.realPath(workspaceRoot))),
    );
    if (destination._tag === 'Failure') {
      return {
        _tag: 'CloneFailed',
        error: systemMessage(destination.failure),
      };
    }

    const cloned = yield* Effect.result(
      ports.showProgress(
        gitClone(overleafGitClone(remote, token.token), destination.success),
      ),
    );
    if (cloned._tag === 'Success') {
      return { _tag: 'Cloned', destination: destination.success };
    }
    if (!isCloneAuthError(cloned.failure)) {
      return { _tag: 'CloneFailed', error: cloned.failure.message };
    }
    yield* ports.secrets.delete(overleafTokenSpec(remote).tokenKey);
    return { _tag: 'AuthFailure', error: cloned.failure.message };
  },
);
