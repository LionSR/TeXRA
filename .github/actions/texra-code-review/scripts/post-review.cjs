const fs = require('node:fs');

function expandRanges(ranges) {
  const result = new Set();
  for (const range of Array.isArray(ranges) ? ranges : []) {
    const start = Number(range.start);
    const end = Number(range.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    for (let line = start; line <= end; line += 1) result.add(line);
  }
  return result;
}

function loadCommentableLines(
  anchorPath = process.env.TEXRA_COMMENTABLE_LINES_JSON ||
    '.texra-action/commentable-lines.json',
) {
  if (!fs.existsSync(anchorPath)) return null;
  const payload = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
  const files = new Map();
  for (const file of Array.isArray(payload.files) ? payload.files : []) {
    if (!file.path) continue;
    files.set(file.path, {
      LEFT: expandRanges(file.left),
      RIGHT: expandRanges(file.right),
    });
  }
  return files;
}

function markedBody(body, marker = process.env.TEXRA_REVIEW_MARKER) {
  const text = String(body || '').trim();
  return `${marker || '<!-- texra-review -->'}\n${text || '## TeXRA Code Review\n\nNo review body was produced.'}`;
}

function formatReviewComment(comment, marker) {
  const result = {
    path: comment.path,
    body: markedBody(comment.body, marker),
  };
  if (comment.position != null) {
    result.position = comment.position;
  } else {
    result.line = comment.line;
    result.side = comment.side || 'RIGHT';
    if (comment.start_line != null) result.start_line = comment.start_line;
    if (comment.start_side) result.start_side = comment.start_side;
  }
  return result;
}

function hasCommentableLine(commentableLines, filePath, side, line) {
  if (!commentableLines) return true;
  const sides = commentableLines.get(filePath);
  return sides?.[side || 'RIGHT']?.has(line) ?? false;
}

function isCommentable(comment, commentableLines) {
  if (comment.position != null) return true;
  if (!Number.isInteger(comment.line)) return false;
  const side = comment.side || 'RIGHT';
  if (!hasCommentableLine(commentableLines, comment.path, side, comment.line)) {
    return false;
  }
  if (comment.start_line != null) {
    return hasCommentableLine(
      commentableLines,
      comment.path,
      comment.start_side || side,
      comment.start_line,
    );
  }
  return true;
}

function fallbackItems(comments, marker) {
  return comments
    .map(
      (comment) =>
        `- \`${comment.path}\`${comment.line ? `:${comment.line}` : ''}: ${comment.body.replaceAll(marker, '').trim()}`,
    )
    .join('\n');
}

function reviewAttributionFooter({
  agent = process.env.TEXRA_REVIEW_AGENT,
  model = process.env.TEXRA_REVIEW_MODEL,
} = {}) {
  const parts = [];
  if (agent) parts.push(`agent \`${agent}\``);
  if (model) parts.push(`model \`${model}\``);
  if (parts.length === 0) return '';
  return `\n\n---\n\nReviewed by TeXRA ${parts.join(' with ')}.`;
}

function loadKnownThreadIds(
  threadContextPath = process.env.TEXRA_THREADS_JSON ||
    '.texra-action/previous-texra-review-threads.json',
) {
  const threadStates = loadKnownThreadStates(threadContextPath);
  return threadStates ? new Set(threadStates.keys()) : null;
}

function loadKnownThreadStates(
  threadContextPath = process.env.TEXRA_THREADS_JSON ||
    '.texra-action/previous-texra-review-threads.json',
) {
  if (!fs.existsSync(threadContextPath)) return null;
  const payload = JSON.parse(fs.readFileSync(threadContextPath, 'utf8'));
  const threads = new Map();
  for (const thread of Array.isArray(payload.threads) ? payload.threads : []) {
    if (typeof thread.id === 'string' && thread.id.trim()) {
      threads.set(thread.id.trim(), { isResolved: thread.isResolved === true });
    }
  }
  return threads;
}

async function postTexraReview({ github, context, core }) {
  const review = JSON.parse(
    fs.readFileSync(process.env.TEXRA_REVIEW_JSON, 'utf8'),
  );
  const marker = process.env.TEXRA_REVIEW_MARKER || '<!-- texra-review -->';
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pull_number = context.payload.pull_request.number;
  const commentableLines = loadCommentableLines();
  const knownThreadStates = loadKnownThreadStates();
  const currentThreadStates = knownThreadStates
    ? new Map(
        [...knownThreadStates.entries()].map(([threadId, state]) => [
          threadId,
          { ...state },
        ]),
      )
    : null;
  const canActOnThreads = process.env.TEXRA_RESOLVE_THREADS === 'true';
  const comments = Array.isArray(review.comments)
    ? review.comments.map((comment) => formatReviewComment(comment, marker))
    : [];
  const inlineComments = [];
  const unplacedComments = [];

  for (const comment of comments) {
    if (isCommentable(comment, commentableLines)) {
      inlineComments.push(comment);
    } else {
      unplacedComments.push(comment);
    }
  }

  let body = markedBody(review.body, marker);
  if (unplacedComments.length > 0) {
    body = `${body}\n\n### Inline comments not placed\n\n${fallbackItems(unplacedComments, marker)}`;
  }

  async function createReview(reviewComments, reviewBody) {
    await github.rest.pulls.createReview({
      owner,
      repo,
      pull_number,
      commit_id: process.env.HEAD_SHA,
      event: 'COMMENT',
      body: reviewBody,
      comments: reviewComments,
    });
  }

  try {
    await createReview(inlineComments, `${body}${reviewAttributionFooter()}`);
  } catch (error) {
    if (inlineComments.length === 0) throw error;
    core.warning(
      `Could not create inline TeXRA review comments; falling back to review body only: ${error.message}`,
    );
    body = `${body}\n\n### Inline comments that could not be placed\n\n${fallbackItems(inlineComments, marker)}`;
    await createReview([], `${body}${reviewAttributionFooter()}`);
  }

  async function replyToThread(threadId, replyBody) {
    await github.graphql(
      `mutation($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: {
          pullRequestReviewThreadId: $threadId,
          body: $body
        }) {
          comment {
            id
          }
        }
      }`,
      { threadId, body: markedBody(replyBody, marker) },
    );
  }

  async function setThreadResolved(threadId, resolved) {
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    await github.graphql(
      `mutation($threadId: ID!) {
        ${mutation}(input: { threadId: $threadId }) {
          thread {
            id
          }
        }
      }`,
      { threadId },
    );
  }

  const threadActions = Array.isArray(review.thread_actions)
    ? review.thread_actions
    : [];
  let skippedThreadActions = 0;
  for (const action of threadActions) {
    const currentThreadState = currentThreadStates?.get(action.thread_id);
    if (currentThreadStates && !currentThreadState) {
      core.warning(
        `Skipping TeXRA thread action ${action.action}: thread id ${action.thread_id} was not found in the previous TeXRA thread context.`,
      );
      continue;
    }
    try {
      if (action.action === 'reply') {
        if (!canActOnThreads) {
          skippedThreadActions += 1;
          continue;
        }
        await replyToThread(action.thread_id, action.body);
      } else if (action.action === 'resolve') {
        if (currentThreadState?.isResolved === true) continue;
        if (!canActOnThreads) {
          skippedThreadActions += 1;
          continue;
        }
        if (action.body) await replyToThread(action.thread_id, action.body);
        await setThreadResolved(action.thread_id, true);
        if (currentThreadState) currentThreadState.isResolved = true;
      } else if (action.action === 'unresolve') {
        if (currentThreadState?.isResolved === false) continue;
        if (!canActOnThreads) {
          skippedThreadActions += 1;
          continue;
        }
        if (action.body) await replyToThread(action.thread_id, action.body);
        await setThreadResolved(action.thread_id, false);
        if (currentThreadState) currentThreadState.isResolved = false;
      }
    } catch (error) {
      core.warning(
        `Could not apply TeXRA thread action ${action.action} for ${action.thread_id}: ${error.message}`,
      );
    }
  }
  if (skippedThreadActions > 0) {
    core.notice(
      `Skipped ${skippedThreadActions} TeXRA review-thread action(s). Configure TEXRA_REVIEW_GITHUB_TOKEN to post previous-thread follow-ups as the TeXRA GitHub identity.`,
    );
  }
}

module.exports = {
  isCommentable,
  loadKnownThreadIds,
  loadKnownThreadStates,
  loadCommentableLines,
  formatReviewComment,
  postTexraReview,
  reviewAttributionFooter,
};
