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

import { z } from 'zod';

import {
  getRunContextWorkingDirectory,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { ToolError, type ToolResult } from '@shared/schemas';
import { requireRunStream } from '@tools/contextHelpers';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { executeCommand } from '@utils/system/execUtils';

import { defineTool } from '../core/define';
import {
  DEFAULT_CHECK_ANNOTATION_LEVEL,
  type GitHubCheckAnnotationLevel,
} from './checkAnnotationLevels';
import { issueRef, prRef } from './githubPaths';
import { getGitHubToken } from './githubAuth';
import { ghGet } from './githubClient';
import {
  MAX_CONCURRENT_ISSUE_SUBSCRIPTIONS,
  MAX_CONCURRENT_PR_SUBSCRIPTIONS,
  MAX_CONCURRENT_REPO_SUBSCRIPTIONS,
  PR_POLL_INTERVAL_MS,
} from './prSubscriptionConstants';
import {
  issueSubscriptionRegistry,
  prSubscriptionRegistry,
  repoSubscriptionRegistry,
} from './subscriptionBindings';
import { SharedIssuePollingSource } from './IssuePollingSource';
import { SharedPRPollingSource } from './PRPollingSource';
import type { GhIssue, GhPullRequest } from './prTypes';

const GitHubSubscriptionInputSchema = z.strictObject({
  command: z.enum(['subscribe', 'unsubscribe', 'list', 'find_current']),
  /**
   * Subscription target — mirrors GitHub's REST URL shape. Required for
   * `subscribe`/`unsubscribe`; ignored for `list`/`find_current`.
   *
   * - `owner/repo`               — repo-wide coarse subscription.
   * - `owner/repo/pulls/N`       — per-PR nuanced subscription.
   * - `owner/repo/issues/N`      — per-issue subscription.
   */
  path: z.string().nullish(),
  /**
   * Lowest inline check-annotation level to send for PR subscriptions.
   * Defaults to failures only; use "warning" to include warnings, or
   * "notice" to include every annotation GitHub reports.
   */
  min_annotation_level: z.enum(['failure', 'warning', 'notice']).nullish(),
  /**
   * Working directory for `find_current` to resolve the current branch's PR.
   * Defaults to the agent's working directory.
   */
  working_directory: z.string().nullish(),
});

type GitHubSubscriptionInput = z.infer<typeof GitHubSubscriptionInputSchema>;

interface ParsedRepoPath {
  kind: 'repo';
  owner: string;
  repo: string;
}
interface ParsedPRPath {
  kind: 'pr';
  owner: string;
  repo: string;
  pullNumber: number;
}
interface ParsedIssuePath {
  kind: 'issue';
  owner: string;
  repo: string;
  issueNumber: number;
}
type ParsedPath = ParsedRepoPath | ParsedPRPath | ParsedIssuePath;

const REPO_PATH_RE = /^([^/\s]+)\/([^/\s]+)$/;
const SUB_PATH_RE = /^([^/\s]+)\/([^/\s]+)\/(pulls|issues)\/(\d+)$/;

function parsePath(raw: string): ParsedPath {
  const trimmed = raw.trim();
  const sub = SUB_PATH_RE.exec(trimmed);
  if (sub) {
    const [, owner, repo, kind, numStr] = sub;
    const n = Number(numStr);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ToolError(`Invalid number in path "${raw}".`);
    }
    return kind === 'pulls'
      ? { kind: 'pr', owner, repo, pullNumber: n }
      : { kind: 'issue', owner, repo, issueNumber: n };
  }
  const repoMatch = REPO_PATH_RE.exec(trimmed);
  if (repoMatch) {
    const [, owner, repo] = repoMatch;
    return { kind: 'repo', owner, repo };
  }
  throw new ToolError(
    `Invalid path "${raw}". Expected "owner/repo", "owner/repo/pulls/N", or "owner/repo/issues/N".`,
  );
}

async function requireToken(): Promise<void> {
  if (!(await getGitHubToken())) {
    throw new ToolError(
      'No GitHub token configured. Set one in host settings (VS Code: TeXRA settings → Git tab → "Set token"), or export GITHUB_TOKEN or GH_TOKEN. Needs `repo` scope for private repos, `public_repo` for public.',
    );
  }
}

/** `owner/repo` for any parsed target. */
function slugOf(target: { owner: string; repo: string }): string {
  return `${target.owner}/${target.repo}`;
}

function requirePath(input: GitHubSubscriptionInput): ParsedPath {
  if (!input.path) {
    throw new ToolError(
      `command="${input.command}" requires a path ("owner/repo", "owner/repo/pulls/N", or "owner/repo/issues/N").`,
    );
  }
  return parsePath(input.path);
}

const ANNOTATION_LEVEL_DESCRIPTIONS: Record<
  GitHubCheckAnnotationLevel,
  string
> = {
  failure: 'failures only',
  warning: 'warnings and failures',
  notice: 'notices, warnings, and failures',
};

/** Shared body sentence describing what a PR subscription delivers. */
function prSubscriptionActivitySentence(
  annotationLevelDescription: string,
): string {
  return `New comments, reviews, line comments, failed CI checks, inline check annotations (${annotationLevelDescription} pinned to file:line), and mergeable_state transitions (merge conflict appeared / resolved) arrive as <github-webhook-activity> follow-ups.`;
}

async function execSubscribe(
  input: GitHubSubscriptionInput,
): Promise<ToolResult> {
  await requireToken();
  const { streamId } = requireRunStream('github_subscription');
  const target = requirePath(input);
  const minAnnotationLevel =
    input.min_annotation_level ?? DEFAULT_CHECK_ANNOTATION_LEVEL;
  const annotationLevelDescription =
    ANNOTATION_LEVEL_DESCRIPTIONS[minAnnotationLevel];
  if (target.kind === 'repo') {
    const created = repoSubscriptionRegistry.bind(streamId, target);
    const slug = slugOf(target);
    return executed(
      created
        ? `Subscribed to repo ${slug}. PR opens/closes/merges, conversation comments on PRs and issues, inline review comments, and newly-detected merge conflicts on open PRs arrive as <github-webhook-activity> follow-ups. Each event uses GitHub's URL form (${slug}/pulls/N or ${slug}/issues/N): pass that path back to command="subscribe" to delegate a worker.`
        : `Already subscribed to repo ${slug}. Activity continues until command="unsubscribe".`,
      created
        ? `Subscribed to repo ${slug}`
        : `Already subscribed to repo ${slug}`,
    );
  }
  if (target.kind === 'pr') {
    const created = prSubscriptionRegistry.bind(streamId, {
      ...target,
      minAnnotationLevel,
    });
    const slug = prRef(slugOf(target), target.pullNumber);
    return executed(
      created
        ? `Subscribed to ${slug}. ${prSubscriptionActivitySentence(annotationLevelDescription)} Auto-unsubscribes on PR close/merge.`
        : `Already subscribed to ${slug}. Inline check annotation filter is now ${annotationLevelDescription}. Activity continues until command="unsubscribe" or the PR closes.`,
      created ? `Subscribed to ${slug}` : `Already subscribed to ${slug}`,
    );
  }
  // The path "owner/repo/issues/N" is ambiguous: the /issues/comments
  // endpoint surfaces both PR conversation comments and plain issue
  // comments, and the repo poller emits /issues/N for the unified case.
  // A worker following that literal path would land on IssuePollingSource
  // even when N is actually a PR — losing reviews, line comments, CI.
  // If either source already knows the entity's type (because some other
  // stream is already subscribed), skip the disambiguation GET and bind
  // directly. The bind itself MUST still run — it's per-stream and the
  // binder dedupes the (streamId, key) pair correctly. Mirrors GitHub's
  // own /issues/N → /pull/N redirect behavior on github.com.
  const issueSlug = issueRef(slugOf(target), target.issueNumber);
  const prSlug = prRef(slugOf(target), target.issueNumber);
  const knownPR = SharedPRPollingSource.has(prSlug);
  const knownIssue = !knownPR && SharedIssuePollingSource.has(issueSlug);
  const isPR =
    knownPR ||
    (!knownIssue &&
      (await resolveIssueIsPR(target.owner, target.repo, target.issueNumber)));

  if (isPR) {
    const created = prSubscriptionRegistry.bind(streamId, {
      owner: target.owner,
      repo: target.repo,
      pullNumber: target.issueNumber,
      minAnnotationLevel,
    });
    let summary: string;
    if (!created) {
      summary = `Already subscribed to ${prSlug}`;
    } else if (!knownPR) {
      summary = `Subscribed to ${prSlug} (was /issues/${target.issueNumber}; resolved to PR)`;
    } else {
      summary = `Subscribed to ${prSlug}`;
    }
    return executed(
      created
        ? `${prSlug} is a PR. ${prSubscriptionActivitySentence(annotationLevelDescription)} Auto-unsubscribes on close/merge.`
        : `Already subscribed to ${prSlug}. Inline check annotation filter is now ${annotationLevelDescription}.`,
      summary,
    );
  }
  const created = issueSubscriptionRegistry.bind(streamId, target);
  return executed(
    created
      ? `Subscribed to ${issueSlug}. New comments and state transitions (closed / reopened) arrive as <github-webhook-activity> follow-ups. The subscription stays active across close so reopens are caught: call command="unsubscribe" to release the slot.`
      : `Already subscribed to ${issueSlug}. Activity continues until command="unsubscribe".`,
    created
      ? `Subscribed to ${issueSlug}`
      : `Already subscribed to ${issueSlug}`,
  );
}

/**
 * Returns true iff the given issue/PR number resolves to a PR. One GET to
 * `/repos/{o}/{r}/issues/{n}`; the response object has a `pull_request`
 * field iff this is actually a PR. Throws on non-200.
 */
async function resolveIssueIsPR(
  owner: string,
  repo: string,
  number: number,
): Promise<boolean> {
  const res = await ghGet<GhIssue>(`/repos/${owner}/${repo}/issues/${number}`);
  if (res.status !== 200) {
    throw new ToolError(
      `Failed to resolve ${owner}/${repo}/issues/${number}: GitHub returned status ${res.status}. ` +
        `Verify the number exists and the repo is accessible.`,
    );
  }
  return res.data.pull_request != null;
}

function execUnsubscribe(input: GitHubSubscriptionInput): ToolResult {
  const { streamId } = requireRunStream('github_subscription');
  const target = requirePath(input);
  const slug = slugOf(target);
  let removed: boolean;
  let label: string;
  if (target.kind === 'repo') {
    removed = repoSubscriptionRegistry.unbind(streamId, target);
    label = `repo ${slug}`;
  } else if (target.kind === 'pr') {
    removed = prSubscriptionRegistry.unbind(streamId, target);
    label = prRef(slug, target.pullNumber);
  } else {
    // Symmetric to subscribe: a /issues/N path may have been re-routed to a
    // PR subscription. Try both — whichever owns it wins.
    const issueRemoved = issueSubscriptionRegistry.unbind(streamId, target);
    const prRemoved = prSubscriptionRegistry.unbind(streamId, {
      owner: target.owner,
      repo: target.repo,
      pullNumber: target.issueNumber,
    });
    removed = issueRemoved || prRemoved;
    label = issueRef(slug, target.issueNumber);
  }
  return {
    status: 'executed',
    summary: removed
      ? `Unsubscribed from ${label}`
      : `Was not subscribed to ${label}`,
  };
}

function execList(): ToolResult {
  const { streamId } = requireRunStream('github_subscription');
  const keysBoundToStream = (
    bindings: ReadonlyArray<{ key: string; streamIds: readonly string[] }>,
  ): string[] =>
    bindings.filter((b) => b.streamIds.includes(streamId)).map((b) => b.key);
  const all = [
    ...keysBoundToStream(repoSubscriptionRegistry.list()),
    ...keysBoundToStream(prSubscriptionRegistry.list()),
    ...keysBoundToStream(issueSubscriptionRegistry.list()),
  ];
  if (all.length === 0) {
    return executed(
      'No active subscriptions on this stream.',
      'No active subscriptions on this stream.',
    );
  }
  return executed(
    all.map((k) => `- ${k}`).join('\n'),
    `${all.length} active subscription(s).`,
  );
}

// GitHub SSH/HTTPS URL → { owner, repo }. Handles `.git` suffix, and repo
// names that themselves contain dots (e.g. `org.github.io`, `my.config`).
const GITHUB_URL_RE =
  /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/;

function parseGitHubRemote(
  remoteUrl: string,
): { owner: string; repo: string } | undefined {
  const m = remoteUrl.trim().match(GITHUB_URL_RE);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2] };
}

async function gitInDir(args: string[], cwd: string): Promise<string> {
  const result = await executeCommand(['git', ...args], {
    cwd,
    timeout: 10_000,
    channel: 'github_subscription',
  });
  if (!result.success) {
    throw new ToolError(
      result.stderr ?? `git ${args.join(' ')} failed with no stderr.`,
    );
  }
  return (result.stdout ?? '').trim();
}

interface OpenPullSummary {
  number: number;
  title?: string;
  head?: { ref?: string };
}

async function getDefaultBranch(owner: string, repo: string): Promise<string> {
  const res = await ghGet<{ default_branch?: string }>(
    `/repos/${owner}/${repo}`,
  );
  if (res.status !== 200) {
    throw new ToolError(`Unexpected GitHub response status: ${res.status}`);
  }
  return res.data.default_branch ?? 'main';
}

export function parseOriginHeadDefaultBranch(ref: string): string | undefined {
  const branch = ref.trim().replace(/^refs\/remotes\//, '');
  if (!branch.startsWith('origin/')) return undefined;
  return branch.slice('origin/'.length) || undefined;
}

async function getLocalDefaultBranchHint(
  cwd: string,
): Promise<string | undefined> {
  try {
    const ref = await gitInDir(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      cwd,
    );
    return parseOriginHeadDefaultBranch(ref);
  } catch {
    return undefined;
  }
}

async function listOpenPullSuggestions(
  owner: string,
  repo: string,
): Promise<string> {
  const res = await ghGet<OpenPullSummary[]>(
    `/repos/${owner}/${repo}/pulls?state=open&per_page=5`,
  );
  if (res.status !== 200 || res.data.length === 0) {
    return '';
  }
  const lines = res.data.map((pr) => {
    const title = pr.title ? ` - ${pr.title}` : '';
    const head = pr.head?.ref ? ` (${pr.head.ref})` : '';
    return `- ${prRef(slugOf({ owner, repo }), pr.number)}${head}${title}`;
  });
  return `\n\nOpen PRs you can subscribe to directly:\n${lines.join('\n')}`;
}

async function getFindCurrentFallbackInfo(
  owner: string,
  repo: string,
  cwd: string,
): Promise<{ defaultBranch?: string; suggestions: string }> {
  const [defaultBranchResult, suggestionsResult] = await Promise.allSettled([
    getDefaultBranch(owner, repo).catch(() => getLocalDefaultBranchHint(cwd)),
    listOpenPullSuggestions(owner, repo),
  ]);
  return {
    defaultBranch:
      defaultBranchResult.status === 'fulfilled'
        ? defaultBranchResult.value
        : undefined,
    suggestions:
      suggestionsResult.status === 'fulfilled' ? suggestionsResult.value : '',
  };
}

async function execFindCurrent(
  input: GitHubSubscriptionInput,
): Promise<ToolResult> {
  await requireToken();
  const cwd =
    parseWorkingDirectory(input.working_directory) ??
    getRunContextWorkingDirectory(tryUseRunContext());
  if (!cwd) {
    throw new ToolError(
      'No working_directory available. Provide one explicitly.',
    );
  }
  let remoteUrl: string;
  let branch: string;
  try {
    remoteUrl = await gitInDir(['remote', 'get-url', 'origin'], cwd);
    branch = await gitInDir(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  } catch (err) {
    throw new ToolError(
      `git invocation failed in ${cwd}: ${toErrorMessage(err)}`,
    );
  }
  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    throw new ToolError(`origin remote is not a github.com URL: ${remoteUrl}`);
  }
  if (branch === 'HEAD') {
    throw new ToolError('HEAD is detached: cannot infer a PR branch.');
  }
  const apiPath = `/repos/${remote.owner}/${remote.repo}/pulls?state=open&head=${remote.owner}:${encodeURIComponent(branch)}&per_page=1`;
  const res =
    await ghGet<
      Array<{ number: number; html_url: string } & Partial<GhPullRequest>>
    >(apiPath);
  if (res.status !== 200) {
    throw new ToolError(`Unexpected GitHub response status: ${res.status}`);
  }
  const pr = res.data[0];
  if (!pr) {
    const { defaultBranch, suggestions } = await getFindCurrentFallbackInfo(
      remote.owner,
      remote.repo,
      cwd,
    );
    if (branch === defaultBranch) {
      throw new ToolError(
        `Current branch is the default branch "${branch}", and no open PR uses it as the head branch. Pass command="subscribe" with an explicit path such as "${remote.owner}/${remote.repo}/pulls/N".${suggestions}`,
      );
    }
    if (!defaultBranch && branch === 'main') {
      throw new ToolError(
        `Current branch is "main", no open PR uses it as the head branch, and the default branch could not be confirmed. Pass command="subscribe" with an explicit path such as "${remote.owner}/${remote.repo}/pulls/N".${suggestions}`,
      );
    }
    throw new ToolError(
      `No open PR found for ${remote.owner}/${remote.repo} head ${branch}. Push this branch and open a PR, or pass command="subscribe" with an explicit path for an existing PR.${suggestions}`,
    );
  }
  const path = prRef(slugOf(remote), pr.number);
  return executed(
    `path: ${path}\nurl: ${pr.html_url}\n\nPass this path to command="subscribe" to start watching the PR.`,
    path,
  );
}

export class GitHubSubscriptionTool extends defineTool({
  name: 'github_subscription',
  description: [
    'Manage GitHub activity subscriptions for the current agent stream.',
    'Path mirrors GitHub\'s REST URL shape and encodes the hierarchy: "owner/repo" addresses the whole repo (coarse, orchestrator-friendly); "owner/repo/pulls/N" addresses a specific pull request and "owner/repo/issues/N" addresses a specific issue (detailed, worker-friendly).',
    'Commands:',
    '- subscribe: start watching the path. For repos: PR opens/closes/merges, conversation comments on PRs and issues, inline review comments, plus a repo-wide merge-conflict probe that flags open PRs whose mergeable_state newly flipped to "dirty" (one event per PR, or a coalesced summary when many PRs flip at once: typical after a base-branch update). For PRs: comments, reviews, line comments, failed CI checks, inline check annotations (notices / warnings / failures pinned to file:line), plus mergeable_state transitions (dirty / resolved). Auto-unsubscribes on close/merge. For issues: comments, closed (with state_reason), reopened: the subscription stays active across close so reopens are caught; call command="unsubscribe" to release the slot.',
    'For PR subscriptions, min_annotation_level controls inline check annotations: "failure" (default) sends failures only, "warning" includes warnings, and "notice" includes every annotation.',
    '- unsubscribe: stop watching the path.',
    '- list: list active subscriptions on this stream.',
    '- find_current: resolve the current git branch to its PR path (returns "owner/repo/pulls/N").',
    'Bot-authored events are dropped end-to-end by policy.',
    `Caps: ${MAX_CONCURRENT_PR_SUBSCRIPTIONS} concurrent PR subscriptions, ${MAX_CONCURRENT_ISSUE_SUBSCRIPTIONS} concurrent issue subscriptions, ${MAX_CONCURRENT_REPO_SUBSCRIPTIONS} concurrent repo subscriptions per process. Poll interval ≈ ${PR_POLL_INTERVAL_MS / 1000}s. Requires a GitHub token: set it in host settings, or via GITHUB_TOKEN or GH_TOKEN.`,
  ].join(' '),
  schema: GitHubSubscriptionInputSchema,
}) {
  protected async execute(input: GitHubSubscriptionInput): Promise<ToolResult> {
    switch (input.command) {
      case 'subscribe':
        return execSubscribe(input);
      case 'unsubscribe':
        return execUnsubscribe(input);
      case 'list':
        return execList();
      case 'find_current':
        return execFindCurrent(input);
    }
  }
}
