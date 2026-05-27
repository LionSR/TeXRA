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

function normalizeComment(comment, marker) {
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
        `- \`${comment.path}\`${comment.line ? `:${comment.line}` : ''}: ${comment.body.replace(marker, '').trim()}`,
    )
    .join('\n');
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
  const comments = Array.isArray(review.comments)
    ? review.comments.map((comment) => normalizeComment(comment, marker))
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
    await createReview(inlineComments, body);
  } catch (error) {
    if (inlineComments.length === 0) throw error;
    core.warning(
      `Could not create inline TeXRA review comments; falling back to review body only: ${error.message}`,
    );
    body = `${body}\n\n### Inline comments that could not be placed\n\n${fallbackItems(inlineComments, marker)}`;
    await createReview([], body);
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
  for (const action of threadActions) {
    try {
      if (action.action === 'reply') {
        await replyToThread(action.thread_id, action.body);
      } else if (action.action === 'resolve') {
        if (action.body) await replyToThread(action.thread_id, action.body);
        await setThreadResolved(action.thread_id, true);
      } else if (action.action === 'unresolve') {
        if (action.body) await replyToThread(action.thread_id, action.body);
        await setThreadResolved(action.thread_id, false);
      }
    } catch (error) {
      core.warning(
        `Could not apply TeXRA thread action ${action.action} for ${action.thread_id}: ${error.message}`,
      );
    }
  }
}

module.exports = {
  isCommentable,
  loadCommentableLines,
  normalizeComment,
  postTexraReview,
};
