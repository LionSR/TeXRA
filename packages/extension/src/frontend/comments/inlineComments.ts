/**
 * Inline comment threads backed by VS Code's native Comments UI
 * (`vscode.comments.createCommentController`). The `inline_comment` tool routes
 * through the provider exposed here so agents can open resolvable,
 * conversational comment threads anchored to a file range — gutter bubbles plus
 * entries in the Comments panel — that the user can reply to and resolve.
 *
 * Unlike inline criticism (lint-style squiggles parsed from `\criticize{}` or
 * pushed via the diagnostics tool), threads here only ever appear when the
 * agent calls the tool, so there is no global enable gate: a folder's window
 * builds the controller at activation and the capability is opt-in via the
 * agent's tool list. The agent reads the user's replies back with the tool's "list" command.
 */

import * as path from 'node:path';

import { Effect, type Scope } from 'effect';
import * as vscode from 'vscode';

import { lineToRange } from '@frontend/vscode/vscodeEditor';
import type { CommandId } from '@texra/shared/commands/catalog';
import type {
  InlineCommentProvider,
  InlineCommentThreadView,
} from '@texra/tools/comment/InlineCommentTool';

const CONTROLLER_ID = 'texra.inlineComments';
const CONTROLLER_LABEL = 'TeXRA';
const AGENT_AUTHOR = 'TeXRA';
const USER_AUTHOR = 'You';
const THREAD_CONTEXT_OPEN = 'texraInlineCommentOpen';
const THREAD_CONTEXT_RESOLVED = 'texraInlineCommentResolved';

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

/** The comment threads' own commands. VS Code calls them with the thread or
 *  reply they were invoked on, so they are registered here rather than with
 *  the commands that take decodable arguments. */
const COMMENT_COMMANDS = {
  'texra.replyComment': (reply: vscode.CommentReply) => {
    appendComment(reply.thread, USER_AUTHOR, reply.text);
  },
  'texra.resolveCommentThread': (thread: vscode.CommentThread) => {
    setThreadResolved(thread, true);
  },
  'texra.unresolveCommentThread': (thread: vscode.CommentThread) => {
    setThreadResolved(thread, false);
  },
} satisfies Partial<Record<CommandId, (arg: never) => void>>;

/** The commands {@link makeInlineComments} registers. */
export type CommentCommandId = keyof typeof COMMENT_COMMANDS;

/**
 * The Comments UI behind the `inline_comment` tool, for the scope that builds
 * it: the controller and the threads' commands are registered here, and the
 * scope's close disposes the threads, the commands and the controller.
 */
export const makeInlineComments: Effect.Effect<
  InlineCommentProvider,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const controller = yield* Effect.acquireRelease(
    Effect.sync(() =>
      vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL),
    ),
    (created) => Effect.sync(() => created.dispose()),
  );
  // No commentingRangeProvider: the user replies to and resolves
  // agent-created threads, but does not start their own from the gutter.
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      Object.entries(COMMENT_COMMANDS).map(([id, run]) =>
        vscode.commands.registerCommand(id, run),
      ),
    ),
    (registered) =>
      Effect.sync(() => {
        for (const command of registered) command.dispose();
      }),
  );
  // Threads share the controller's lifetime. VS Code exposes no event for a
  // thread being closed or deleted, and resolved threads remain
  // user-visible, reopenable, and readable by the agent.
  const threads = new Map<string, vscode.CommentThread>();
  let sequence = 0;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const thread of threads.values()) thread.dispose();
      threads.clear();
    }),
  );
  return {
    add: ({ absolutePath, line, endLine, body }) => {
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
      return [...threads.entries()]
        .filter(
          ([, thread]) =>
            !comparablePath ||
            comparableFsPath(thread.uri.fsPath) === comparablePath,
        )
        .map(([threadId, thread]) => toView(threadId, thread));
    },
  };
});
