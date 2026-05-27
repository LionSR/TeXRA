const fs = require('node:fs');
const path = require('node:path');

const { writeOutput } = require('./github-output.cjs');

const DEFAULT_REVIEW_BODY = 'TeXRA completed without a final review message.';
const STATUS_ONLY_MESSAGES = new Set([
  'complete',
  'completed',
  'done',
  'ok',
  'success',
  'succeeded',
]);

function isStatusOnlyMessage(value) {
  return STATUS_ONLY_MESSAGES.has(value.trim().toLowerCase());
}

function integerOrUndefined(value) {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function sideOrUndefined(value) {
  return value === 'LEFT' || value === 'RIGHT' ? value : undefined;
}

function stringOrUndefined(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fencedJsonBlocks(text) {
  return Array.from(
    text.matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gim),
    (match) => match[1],
  );
}

function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {}

  for (const fenced of fencedJsonBlocks(text)) {
    try {
      return JSON.parse(fenced);
    } catch {}
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }

  return undefined;
}

function normalizeModelComment(comment) {
  if (!comment || typeof comment !== 'object') return undefined;
  const pathValue = stringOrUndefined(comment.path);
  const body = stringOrUndefined(comment.body);
  const line = integerOrUndefined(comment.line);
  const position = integerOrUndefined(comment.position);
  if (!pathValue || !body || (line == null && position == null)) {
    return undefined;
  }

  const normalized = { path: pathValue, body };
  if (line != null) {
    normalized.line = line;
    normalized.side = sideOrUndefined(comment.side) ?? 'RIGHT';
    const startLine = integerOrUndefined(
      comment.start_line ?? comment.startLine,
    );
    if (startLine != null) normalized.start_line = startLine;
    const startSide = sideOrUndefined(comment.start_side ?? comment.startSide);
    if (startSide) normalized.start_side = startSide;
  } else {
    normalized.position = position;
  }
  return normalized;
}

function normalizeThreadAction(action) {
  if (!action || typeof action !== 'object') return undefined;
  const kind = stringOrUndefined(action.action);
  const threadId = stringOrUndefined(action.thread_id ?? action.threadId);
  if (
    !threadId ||
    (kind !== 'reply' && kind !== 'resolve' && kind !== 'unresolve')
  ) {
    return undefined;
  }
  const body = stringOrUndefined(action.body);
  if (kind === 'reply' && !body) return undefined;
  return {
    action: kind,
    thread_id: threadId,
    ...(body ? { body } : {}),
  };
}

function dedupeThreadActions(actions) {
  const actionsByThread = new Map();
  for (const action of actions) {
    const key = `${action.action}\0${action.thread_id}`;
    const existing = actionsByThread.get(key);
    if (!existing || (!existing.body && action.body)) {
      actionsByThread.set(key, action);
    }
  }
  return [...actionsByThread.values()];
}

function normalizeReview(rawText) {
  const modelPayload = parseModelJson(rawText);
  if (!modelPayload || typeof modelPayload !== 'object') {
    return { body: rawText, comments: [], thread_actions: [] };
  }

  const body =
    stringOrUndefined(modelPayload.body) ??
    stringOrUndefined(modelPayload.summary) ??
    DEFAULT_REVIEW_BODY;
  const comments = Array.isArray(modelPayload.comments)
    ? modelPayload.comments.map(normalizeModelComment).filter(Boolean)
    : [];
  const rawThreadActions = [
    ...(Array.isArray(modelPayload.thread_actions)
      ? modelPayload.thread_actions
      : []),
    ...(Array.isArray(modelPayload.threadActions)
      ? modelPayload.threadActions
      : []),
    ...(Array.isArray(modelPayload.thread_replies)
      ? modelPayload.thread_replies.map((reply) => ({
          ...reply,
          action: 'reply',
        }))
      : []),
    ...(Array.isArray(modelPayload.resolved_threads)
      ? modelPayload.resolved_threads.map((thread) => ({
          ...thread,
          action: 'resolve',
        }))
      : []),
    ...(Array.isArray(modelPayload.unresolved_threads)
      ? modelPayload.unresolved_threads.map((thread) => ({
          ...thread,
          action: 'unresolve',
        }))
      : []),
  ];

  return {
    body,
    comments: comments.slice(0, 50),
    thread_actions: dedupeThreadActions(
      rawThreadActions.map(normalizeThreadAction).filter(Boolean),
    ).slice(0, 50),
  };
}

function normalizeReviewFile({
  resultJson = process.env.RESULT_JSON,
  outputFile = process.env.INPUT_OUTPUT_FILE,
  runnerTemp = process.env.RUNNER_TEMP || '/tmp',
} = {}) {
  const raw = fs.readFileSync(resultJson, 'utf8');
  const payload = JSON.parse(raw);
  const result = payload.result ?? payload;
  const candidateFinalMessage = String(result.lastResponse || '').trim();
  const rawFinalMessage =
    candidateFinalMessage && !isStatusOnlyMessage(candidateFinalMessage)
      ? candidateFinalMessage
      : DEFAULT_REVIEW_BODY;
  const review = normalizeReview(rawFinalMessage);
  const finalMessage = review.body.trim();
  const resolvedOutputFile =
    outputFile || path.join(runnerTemp, 'texra-code-review.md');
  const reviewJsonFile = path.join(
    runnerTemp,
    'texra-code-review-normalized.json',
  );

  fs.mkdirSync(path.dirname(resolvedOutputFile), { recursive: true });
  fs.writeFileSync(resolvedOutputFile, `${finalMessage}\n`);
  fs.writeFileSync(reviewJsonFile, `${JSON.stringify(review, null, 2)}\n`);

  writeOutput('final-message', finalMessage);
  writeOutput('output-file', resolvedOutputFile);
  writeOutput('review-json', reviewJsonFile);

  return { finalMessage, outputFile: resolvedOutputFile, reviewJsonFile };
}

if (require.main === module) {
  normalizeReviewFile();
}

module.exports = {
  dedupeThreadActions,
  fencedJsonBlocks,
  normalizeModelComment,
  normalizeReview,
  normalizeReviewFile,
  normalizeThreadAction,
  parseModelJson,
};
