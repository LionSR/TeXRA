/**
 * Inline comment threads backed by VS Code's native Comments UI
 * (`vscode.comments.createCommentController`). The `inline_comment` tool routes
 * through the provider exposed here so tool-use agents can open resolvable,
 * conversational comment threads anchored to a file range — gutter bubbles plus
 * entries in the Comments panel — that the user can reply to and resolve.
 *
 * Unlike inline criticism (lint-style squiggles parsed from `\criticize{}` or
 * pushed via the diagnostics tool), threads here only ever appear when the
 * agent calls the tool, so there is no global enable gate: the controller is
 * registered at activation and the capability is opt-in via the agent's tool
 * list. The agent reads the user's replies back with the tool's "list" command.
 */

import * as path from 'node:path';

import * as vscode from 'vscode';

import { lineToRange } from '@frontend/vscode/vscodeEditor';
import * as logger from '@logger/logUtils';
import type {
  InlineCommentProvider,
  InlineCommentThreadView,
} from '@tools/comment/InlineCommentTool';

const CHANNEL = 'InlineComments';
const CONTROLLER_ID = 'texra.inlineComments';
const CONTROLLER_LABEL = 'TeXRA';
const AGENT_AUTHOR = 'TeXRA';
const USER_AUTHOR = 'You';
const THREAD_CONTEXT_OPEN = 'texraInlineCommentOpen';
const THREAD_CONTEXT_RESOLVED = 'texraInlineCommentResolved';

let controller: vscode.CommentController | undefined;
// Threads intentionally share the controller's lifetime. VS Code exposes no
// event for a thread being closed or deleted, and resolved threads remain
// user-visible, reopenable, and readable by the agent. `disable` owns cleanup.
const threads = new Map<string, vscode.CommentThread>();
let sequence = 0;

function makeComment(author: string, body: string): vscode.Comment {
  return {
    author: { name: author },
    body: new vscode.MarkdownString(body),
    mode: vscode.CommentMode.Preview,
  };
}

function appendComment(
  thread: vscode.CommentThread,
  author: string,
  body: string,
): void {
  // VS Code only re-renders when `comments` is reassigned, not mutated.
  thread.comments = [...thread.comments, makeComment(author, body)];
}

function comparableFsPath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function setThreadResolved(
  thread: vscode.CommentThread,
  resolved: boolean,
): void {
  thread.state = resolved
    ? vscode.CommentThreadState.Resolved
    : vscode.CommentThreadState.Unresolved;
  thread.contextValue = resolved
    ? THREAD_CONTEXT_RESOLVED
    : THREAD_CONTEXT_OPEN;
}

function toView(
  threadId: string,
  thread: vscode.CommentThread,
): InlineCommentThreadView {
  // `range` is optional in the API typings; agent threads always set one, but
  // fall back to line 1 if a future commenting-range path leaves it undefined.
  const range = thread.range;
  return {
    threadId,
    path: thread.uri.fsPath,
    line: (range?.start.line ?? 0) + 1,
    endLine: (range?.end.line ?? 0) + 1,
    resolved: thread.state === vscode.CommentThreadState.Resolved,
    comments: thread.comments.map((comment) => ({
      author: comment.author.name,
      body:
        typeof comment.body === 'string' ? comment.body : comment.body.value,
    })),
  };
}

const provider: InlineCommentProvider = {
  available: () => controller !== undefined,

  add: ({ absolutePath, line, endLine, body }) => {
    if (!controller) return null;
    const uri = vscode.Uri.file(absolutePath);
    const range = lineToRange(line, endLine);
    const thread = controller.createCommentThread(uri, range, [
      makeComment(AGENT_AUTHOR, body),
    ]);
    sequence += 1;
    const threadId = `c${sequence}`;
    thread.label = threadId;
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    setThreadResolved(thread, false);
    threads.set(threadId, thread);
    return { threadId, resolvedPath: absolutePath };
  },

  reply: ({ threadId, body }) => {
    const thread = threads.get(threadId);
    if (!thread) return false;
    appendComment(thread, AGENT_AUTHOR, body);
    return true;
  },

  setResolved: ({ threadId, resolved }) => {
    const thread = threads.get(threadId);
    if (!thread) return false;
    setThreadResolved(thread, resolved);
    return true;
  },

  list: ({ absolutePath }) => {
    const comparablePath =
      absolutePath == null ? undefined : comparableFsPath(absolutePath);
    const views: InlineCommentThreadView[] = [];
    for (const [threadId, thread] of threads) {
      if (
        comparablePath &&
        comparableFsPath(thread.uri.fsPath) !== comparablePath
      ) {
        continue;
      }
      views.push(toView(threadId, thread));
    }
    return views;
  },
};

function enable(context: vscode.ExtensionContext): void {
  if (controller) return;
  controller = vscode.comments.createCommentController(
    CONTROLLER_ID,
    CONTROLLER_LABEL,
  );
  // No commentingRangeProvider: the user replies to and resolves agent-created
  // threads, but does not start their own from the gutter.
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand(
      'texra.replyComment',
      (reply: vscode.CommentReply) => {
        appendComment(reply.thread, USER_AUTHOR, reply.text);
      },
    ),
    vscode.commands.registerCommand(
      'texra.resolveCommentThread',
      (thread: vscode.CommentThread) => {
        setThreadResolved(thread, true);
      },
    ),
    vscode.commands.registerCommand(
      'texra.unresolveCommentThread',
      (thread: vscode.CommentThread) => {
        setThreadResolved(thread, false);
      },
    ),
  );
  logger.info(CHANNEL, 'Inline comments enabled');
}

function disable(): void {
  for (const thread of threads.values()) thread.dispose();
  threads.clear();
  controller?.dispose();
  controller = undefined;
}

/** Register the comment controller and reply/resolve commands at activation. */
export function registerInlineComments(context: vscode.ExtensionContext): void {
  enable(context);
  context.subscriptions.push({ dispose: disable });
}

/** The provider injected into the `inline_comment` tool. */
export function getInlineCommentProvider(): InlineCommentProvider {
  return provider;
}
