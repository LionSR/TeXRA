/**
 * Unified agent-facing tool for managing GitHub activity subscriptions.
 *
 * Surface mirrors the memory tool: a single tool with a `command`
 * discriminator and a `path` that addresses the subscription target.
 * Path form mirrors GitHub's REST URL shape.
 *
 *   command='subscribe',     path='owner/repo'              → repo-wide
 *   command='subscribe',     path='owner/repo/pulls/42'     → per-PR
 *   command='subscribe',     path='owner/repo/issues/42'    → per-issue
 *   command='unsubscribe',   path=…                         → mirror
 *   command='list'                                          → active subs
 *   command='find_current'                                  → branch → path
 *
 * The hierarchy is encoded in the path:
 * - `owner/repo` is coarse (orchestrator-friendly).
 * - `owner/repo/pulls/N` and `owner/repo/issues/N` are nuanced (worker-friendly).
 */

import { Effect, Result, Schema } from 'effect';

import { defineTool, type ToolResult } from '@texra-ai/harness';
import { ToolContext } from '@texra-ai/harness/plugins';
import { Secrets } from '@texra-ai/harness/host';
import {
  ChildRuns,
  requireRun,
  type RunInbox,
  parseWorkingDirectory,
  nullishWithDefault,
  executed,
  ToolError,
} from '@texra-ai/harness/plugins';
import type { RunId } from '@texra-ai/harness/schemas';

import {
  DEFAULT_CHECK_ANNOTATION_LEVEL,
  type GitHubCheckAnnotationLevel,
} from './checkAnnotationLevels';
import { getGitHubToken } from './githubAuth';
import { ghGet, type GitHubServices } from './githubClient';
import {
  GITHUB_POLL_INTERVAL_MS,
  MAX_SUBSCRIPTIONS,
} from './prSubscriptionConstants';
import { GitHubSubscriptions } from './subscriptionBindings';
import {
  SubscriptionTargetPath,
  targetPath,
  type IssueTarget,
  type PullTarget,
  type SubscriptionTarget,
} from './subscriptionTarget';
import { parseGitHubSlug } from './githubSlug';
import {
  currentBranch,
  originDefaultBranch,
  originUrl,
} from '@texra/utils/git/gitReads';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { GhIssue } from './prTypes';
import type { SettingsStores } from '@texra-ai/harness/host';

/**
 * What each level brings in, keyed by level. Declared above the schema because
 * the schema's own `describe` reads it at module load.
 */
const ANNOTATION_LEVEL_DESCRIPTIONS: Record<
  GitHubCheckAnnotationLevel,
  string
> = {
  failure: 'failures only',
  warning: 'warnings and failures',
  notice: 'notices, warnings, and failures',
};

/** The default level's own description, for the two model-facing strings. */
const DEFAULT_ANNOTATION_LEVEL_DESCRIPTION =
  ANNOTATION_LEVEL_DESCRIPTIONS[DEFAULT_CHECK_ANNOTATION_LEVEL];

const SUBSCRIPTION_PATH_DESCRIPTION =
  'Subscription target, mirroring GitHub\'s REST URL shape: "owner/repo" (repo-wide, coarse), "owner/repo/pulls/N" (per-PR, nuanced), or "owner/repo/issues/N" (per-issue).';

// Provider schema flattening advertises one object across commands, and
// OpenAI-compatible providers null-fill the other branches' fields; a plain
// `Struct` branch ignores those keys.
const GitHubSubscriptionInputSchema = Schema.Union([
  Schema.Struct({
    command: Schema.Literal('subscribe').annotate({
      description: 'Start watching the path.',
    }),
    path: Schema.String.annotate({
      description: SUBSCRIPTION_PATH_DESCRIPTION,
    }),
    /**
     * Lowest inline check-annotation level to send for PR subscriptions.
     * Defaults to `DEFAULT_CHECK_ANNOTATION_LEVEL`; use "warning" to include
     * warnings, or "notice" to include every annotation GitHub reports.
     */
    min_annotation_level: nullishWithDefault(
      Schema.Literals(['failure', 'warning', 'notice']),
      DEFAULT_CHECK_ANNOTATION_LEVEL,
      `Lowest inline check-annotation level for PR subscriptions. Defaults to ${DEFAULT_ANNOTATION_LEVEL_DESCRIPTION}; "warning" includes warnings, "notice" includes every annotation.`,
    ),
  }),
  Schema.Struct({
    command: Schema.Literal('unsubscribe').annotate({
      description: 'Stop watching the path.',
    }),
    path: Schema.String.annotate({
      description: SUBSCRIPTION_PATH_DESCRIPTION,
    }),
  }),
  Schema.Struct({
    command: Schema.Literal('list').annotate({
      description: 'List active subscriptions on this run.',
    }),
  }),
  Schema.Struct({
    command: Schema.Literal('find_current').annotate({
      description:
        'Resolve the current git branch to its PR path ("owner/repo/pulls/N").',
    }),
    /**
     * Working directory for `find_current` to resolve the current branch's PR.
     * Defaults to the agent's working directory.
     */
    working_directory: Schema.optional(Schema.NullOr(Schema.String)).annotate({
      description:
        "Working directory to resolve the current branch's PR. Defaults to the agent's working directory.",
    }),
  }),
]);

type GitHubSubscriptionInput = typeof GitHubSubscriptionInputSchema.Type;
type SubscribeInput = Extract<
  GitHubSubscriptionInput,
  { command: 'subscribe' }
>;
type UnsubscribeInput = Extract<
  GitHubSubscriptionInput,
  { command: 'unsubscribe' }
>;
type FindCurrentInput = Extract<
  GitHubSubscriptionInput,
  { command: 'find_current' }
>;

const requireToken = Effect.fn('githubSubscriptionTool.requireToken')(
  function* (): Effect.fn.Return<void, Error, Secrets> {
    const secrets = yield* Secrets;
    const token = yield* getGitHubToken(secrets);
    if (!token) {
      return yield* Effect.fail(
        new ToolError(
          'No GitHub token configured. In the CLI, open /config → GitHub token. In VS Code, use TeXRA Settings → General → "Set token". Or export GITHUB_TOKEN or GH_TOKEN. Needs `repo` scope for private repos, `public_repo` for public.',
        ),
      );
    }
  },
);

const PATH_FORMS =
  '"owner/repo", "owner/repo/pulls/N", or "owner/repo/issues/N"';

const decodeTargetPath = Schema.decodeUnknownResult(SubscriptionTargetPath);

/** The target `raw` names; the input's union already requires a path. */
function parsePath(raw: string): Effect.Effect<SubscriptionTarget, ToolError> {
  const target = decodeTargetPath(raw.trim());
  return Result.isSuccess(target)
    ? Effect.succeed(target.success)
    : Effect.fail(
        new ToolError(`Invalid path "${raw}". Expected ${PATH_FORMS}.`),
      );
}

/** Shared body sentence describing what a PR subscription delivers. */
function prSubscriptionActivitySentence(
  annotationLevelDescription: string,
): string {
  return `New comments, reviews, line comments, failed CI checks, inline check annotations (${annotationLevelDescription} pinned to file:line), and mergeable_state transitions (merge conflict appeared / resolved) arrive as <github-webhook-activity> follow-ups.`;
}

const execSubscribe = Effect.fn('GitHubSubscriptionTool.subscribe')(function* (
  input: SubscribeInput,
  runId: RunId,
  inbox: RunInbox,
) {
  yield* requireToken();
  const subscriptions = yield* GitHubSubscriptions;
  const requested = yield* parsePath(input.path);
  const minAnnotationLevel = input.min_annotation_level;
  const annotationLevelDescription =
    ANNOTATION_LEVEL_DESCRIPTIONS[minAnnotationLevel];
  // "owner/repo/issues/N" may name a PR: the /issues/comments endpoint
  // surfaces PR conversation comments too, and the repo poller reports them
  // under /issues/N. Following that path to an issue subscription would lose
  // reviews, line comments and CI, so it resolves to the PR when GitHub says
  // it is one, mirroring github.com's own /issues/N → /pull/N redirect.
  const target =
    requested._tag === 'issue' && (yield* resolveIssueIsPR(requested))
      ? pullOf(requested)
      : requested;
  const created = yield* subscriptions.bind(
    runId,
    target,
    inbox,
    minAnnotationLevel,
  );
  const path = targetPath(target);
  const summary = created
    ? `Subscribed to ${path}`
    : `Already subscribed to ${path}`;
  switch (target._tag) {
    case 'repo':
      return executed(
        created
          ? `Subscribed to repo ${path}. PR opens/closes/merges, conversation comments on PRs and issues, inline review comments, and newly-detected merge conflicts on open PRs arrive as <github-webhook-activity> follow-ups. Each event uses GitHub's URL form (${path}/pulls/N or ${path}/issues/N): pass that path back to command="subscribe" to delegate a worker.`
          : `Already subscribed to repo ${path}. Activity continues until command="unsubscribe".`,
        created
          ? `Subscribed to repo ${path}`
          : `Already subscribed to repo ${path}`,
      );
    case 'pull':
      if (requested._tag === 'issue') {
        return executed(
          created
            ? `${path} is a PR. ${prSubscriptionActivitySentence(annotationLevelDescription)} Auto-unsubscribes on close/merge.`
            : `Already subscribed to ${path}. Inline check annotation filter is now ${annotationLevelDescription}.`,
          created
            ? `Subscribed to ${path} (was /issues/${target.number}; resolved to PR)`
            : summary,
        );
      }
      return executed(
        created
          ? `Subscribed to ${path}. ${prSubscriptionActivitySentence(annotationLevelDescription)} Auto-unsubscribes on PR close/merge.`
          : `Already subscribed to ${path}. Inline check annotation filter is now ${annotationLevelDescription}. Activity continues until command="unsubscribe" or the PR closes.`,
        summary,
      );
    case 'issue':
      return executed(
        created
          ? `Subscribed to ${path}. New comments and state transitions (closed / reopened) arrive as <github-webhook-activity> follow-ups. The subscription stays active across close so reopens are caught: call command="unsubscribe" to release the slot.`
          : `Already subscribed to ${path}. Activity continues until command="unsubscribe".`,
        summary,
      );
  }
});

/** The pull request with an issue target's owner, repository and number. */
function pullOf(issue: IssueTarget): PullTarget {
  return { ...issue, _tag: 'pull' };
}

/** The 200 body of an unconditional GET, or a ToolError naming the status. */
const ghGetOk = <T>(
  path: string,
  failure = (status: number) => `Unexpected GitHub response status: ${status}`,
): Effect.Effect<T, Error, GitHubServices> =>
  Effect.flatMap(ghGet<T>(path), (res) =>
    res.status === 200
      ? Effect.succeed(res.data)
      : Effect.fail(new ToolError(failure(res.status))),
  );

/**
 * Returns true iff the given issue number resolves to a PR. One GET to
 * `/repos/{o}/{r}/issues/{n}`; the response object has a `pull_request`
 * field iff this is actually a PR. Fails with a ToolError on non-200.
 */
const resolveIssueIsPR = (
  issue: IssueTarget,
): Effect.Effect<boolean, Error, GitHubServices> =>
  Effect.map(
    ghGetOk<GhIssue>(
      `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`,
      (status) =>
        `Failed to resolve ${targetPath(issue)}: GitHub returned status ${status}. ` +
        `Verify the number exists and the repo is accessible.`,
    ),
    (found) => found.pull_request != null,
  );

const execUnsubscribe = Effect.fn('GitHubSubscriptionTool.unsubscribe')(
  function* (input: UnsubscribeInput, runId: RunId) {
    const subscriptions = yield* GitHubSubscriptions;
    const target = yield* parsePath(input.path);
    // Symmetric to subscribe: an /issues/N path may have been bound as the
    // PR it names.
    const removed =
      (yield* subscriptions.unbind(runId, target)) ||
      (target._tag === 'issue' &&
        (yield* subscriptions.unbind(runId, pullOf(target))));
    const label =
      target._tag === 'repo'
        ? `repo ${targetPath(target)}`
        : targetPath(target);
    return {
      status: 'executed',
      summary: removed
        ? `Unsubscribed from ${label}`
        : `Was not subscribed to ${label}`,
    } satisfies ToolResult;
  },
);

const execList = Effect.fn('GitHubSubscriptionTool.list')(function* (
  runId: RunId,
) {
  const subscriptions = yield* GitHubSubscriptions;
  const bound = (yield* subscriptions.list)
    .filter((entry) => entry.runIds.includes(runId))
    .map((entry) => targetPath(entry.target));
  if (bound.length === 0) {
    return executed(
      'No active subscriptions on this run.',
      'No active subscriptions on this run.',
    );
  }
  return executed(
    bound.map((path) => `- ${path}`).join('\n'),
    `${bound.length} active subscription(s).`,
  );
});

interface OpenPullSummary {
  number: number;
  title?: string;
  head?: { ref?: string };
}

/** The repository's default branch as GitHub reports it; a response that
 *  names none leaves it unconfirmed rather than guessed. */
const getDefaultBranch = (
  owner: string,
  repo: string,
): Effect.Effect<string | undefined, Error, GitHubServices> =>
  Effect.map(
    ghGetOk<{ default_branch?: string }>(`/repos/${owner}/${repo}`),
    (repository) => repository.default_branch,
  );

const listOpenPullSuggestions = (
  owner: string,
  repo: string,
): Effect.Effect<string, Error, GitHubServices> =>
  Effect.map(
    ghGet<OpenPullSummary[]>(
      `/repos/${owner}/${repo}/pulls?state=open&per_page=5`,
    ),
    (res) => {
      if (res.status !== 200 || res.data.length === 0) {
        return '';
      }
      const lines = res.data.map((pr) => {
        const title = pr.title ? ` - ${pr.title}` : '';
        const head = pr.head?.ref ? ` (${pr.head.ref})` : '';
        return `- ${targetPath({ _tag: 'pull', owner, repo, number: pr.number })}${head}${title}`;
      });
      return `\n\nOpen PRs you can subscribe to directly:\n${lines.join('\n')}`;
    },
  );

/** Neither half is essential: each recovers, logged, to the local origin/HEAD
 *  hint or to no suggestions, concurrently. */
const getFindCurrentFallbackInfo = (
  owner: string,
  repo: string,
  cwd: string,
  settings: SettingsStores,
): Effect.Effect<
  { defaultBranch?: string; suggestions: string },
  never,
  GitHubServices | ChildProcessSpawner
> =>
  Effect.zip(
    getDefaultBranch(owner, repo).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `The default branch of ${owner}/${repo} could not be read; using origin/HEAD: ${error.message}`,
        ).pipe(
          Effect.andThen(originDefaultBranch(cwd, settings)),
          Effect.map((branch) => branch ?? undefined),
        ),
      ),
    ),
    listOpenPullSuggestions(owner, repo).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `The open PRs of ${owner}/${repo} could not be listed: ${error.message}`,
        ).pipe(Effect.as('')),
      ),
    ),
    { concurrent: true },
  ).pipe(
    Effect.map(([defaultBranch, suggestions]) => ({
      defaultBranch,
      suggestions,
    })),
  );

const execFindCurrent = Effect.fn('GitHubSubscriptionTool.findCurrent')(
  function* (
    input: FindCurrentInput,
    workingDirectory: string | undefined,
    settings: SettingsStores,
  ) {
    yield* requireToken();
    const cwd =
      (yield* Effect.fromResult(
        parseWorkingDirectory(input.working_directory),
      )) ?? workingDirectory;
    if (!cwd) {
      return yield* Effect.fail(
        new ToolError(
          'No working_directory available. Provide one explicitly.',
        ),
      );
    }
    const [remoteUrl, branch] = yield* Effect.all(
      [originUrl(cwd, settings), currentBranch(cwd, settings)],
      { concurrency: 'unbounded' },
    );
    if (remoteUrl === null) {
      return yield* Effect.fail(
        new ToolError(
          `${cwd} has no readable origin remote (it may not be a git repository).`,
        ),
      );
    }
    const remote = parseGitHubSlug(remoteUrl);
    if (!remote) {
      return yield* Effect.fail(
        new ToolError(`origin remote is not a github.com URL: ${remoteUrl}`),
      );
    }
    if (branch === null) {
      return yield* Effect.fail(
        new ToolError('HEAD is detached: cannot infer a PR branch.'),
      );
    }
    const apiPath = `/repos/${remote.owner}/${remote.repo}/pulls?state=open&head=${remote.owner}:${encodeURIComponent(branch)}&per_page=1`;
    const [pr] =
      yield* ghGetOk<Array<{ number: number; html_url: string }>>(apiPath);
    if (!pr) {
      const { defaultBranch, suggestions } = yield* getFindCurrentFallbackInfo(
        remote.owner,
        remote.repo,
        cwd,
        settings,
      );
      if (branch === defaultBranch) {
        return yield* Effect.fail(
          new ToolError(
            `Current branch is the default branch "${branch}", and no open PR uses it as the head branch. Pass command="subscribe" with an explicit path such as "${remote.owner}/${remote.repo}/pulls/N".${suggestions}`,
          ),
        );
      }
      if (!defaultBranch && branch === 'main') {
        return yield* Effect.fail(
          new ToolError(
            `Current branch is "main", no open PR uses it as the head branch, and the default branch could not be confirmed. Pass command="subscribe" with an explicit path such as "${remote.owner}/${remote.repo}/pulls/N".${suggestions}`,
          ),
        );
      }
      return yield* Effect.fail(
        new ToolError(
          `No open PR found for ${remote.owner}/${remote.repo} head ${branch}. Push this branch and open a PR, or pass command="subscribe" with an explicit path for an existing PR.${suggestions}`,
        ),
      );
    }
    const path = targetPath({ _tag: 'pull', ...remote, number: pr.number });
    return executed(
      `path: ${path}\nurl: ${pr.html_url}\n\nPass this path to command="subscribe" to start watching the PR.`,
      path,
    );
  },
);

export const GitHubSubscriptionTool = defineTool({
  name: 'github_subscription',
  description: [
    'Manage GitHub activity subscriptions for the current agent run.',
    'Path mirrors GitHub\'s REST URL shape and encodes the hierarchy: "owner/repo" addresses the whole repo (coarse, orchestrator-friendly); "owner/repo/pulls/N" addresses a specific pull request and "owner/repo/issues/N" addresses a specific issue (detailed, worker-friendly).',
    'Commands:',
    '- subscribe: start watching the path. For repos: PR opens/closes/merges, conversation comments on PRs and issues, inline review comments, plus a repo-wide merge-conflict probe that flags open PRs whose mergeable_state newly flipped to "dirty" (one event per PR, or a coalesced summary when many PRs flip at once: typical after a base-branch update). For PRs: comments, reviews, line comments, failed CI checks, inline check annotations (notices / warnings / failures pinned to file:line), plus mergeable_state transitions (dirty / resolved). Auto-unsubscribes on close/merge. For issues: comments, closed (with state_reason), reopened: the subscription stays active across close so reopens are caught; call command="unsubscribe" to release the slot.',
    `For PR subscriptions, min_annotation_level controls inline check annotations: "${DEFAULT_CHECK_ANNOTATION_LEVEL}" (default) sends ${DEFAULT_ANNOTATION_LEVEL_DESCRIPTION}, "warning" includes warnings, and "notice" includes every annotation.`,
    '- unsubscribe: stop watching the path.',
    '- list: list active subscriptions on this run.',
    '- find_current: resolve the current git branch to its PR path (returns "owner/repo/pulls/N").',
    'Bot-authored events are dropped end-to-end by policy.',
    `Caps: ${MAX_SUBSCRIPTIONS.pull} concurrent PR subscriptions, ${MAX_SUBSCRIPTIONS.issue} concurrent issue subscriptions, ${MAX_SUBSCRIPTIONS.repo} concurrent repo subscriptions per process. Poll interval ≈ ${GITHUB_POLL_INTERVAL_MS / 1000}s. Requires a GitHub token: set it via /config → GitHub token (CLI), Settings → General (VS Code / desktop), or GITHUB_TOKEN / GH_TOKEN.`,
  ].join(' '),
  schema: GitHubSubscriptionInputSchema,
  execute: Effect.fn('githubSubscriptionTool.execute')(function* (
    input: GitHubSubscriptionInput,
  ) {
    const toolCall = yield* ToolContext;
    const { run } = yield* requireRun('github_subscription');
    switch (input.command) {
      case 'subscribe':
        return yield* execSubscribe(
          input,
          run.runId,
          yield* (yield* ChildRuns).inbox(run.runId),
        );
      case 'unsubscribe':
        return yield* execUnsubscribe(input, run.runId);
      case 'list':
        return yield* execList(run.runId);
      case 'find_current':
        return yield* execFindCurrent(
          input,
          toolCall.env.workingDirectory,
          toolCall.env.roots,
        );
    }
  }),
});
