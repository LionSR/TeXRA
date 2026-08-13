// Third-party imports
import { z } from 'zod';

// Internal imports
import {
  getRunContextWorkingDirectory,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { createLog } from '@logger/logUtils';
import { ToolError, type ToolResult } from '@shared/schemas';
import { resolveWorkspaceRelativePath } from '@tools/pathResolution';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from '../core/define';

const log = createLog('InlineCommentTool');

/** A single comment within a thread, as seen by the agent. */
interface InlineCommentView {
  author: string;
  body: string;
}

/** A comment thread anchored to a file range, as seen by the agent. */
export interface InlineCommentThreadView {
  threadId: string;
  /** Path as reported by the host (typically the resolved absolute path). */
  path: string;
  /** 1-based start line. */
  line: number;
  /** 1-based end line. */
  endLine: number;
  resolved: boolean;
  comments: InlineCommentView[];
}

/**
 * Host-implemented provider for inline comment threads, injected by the
 * extension host and backed by the VS Code CommentController. Absent on hosts
 * without one (CLI / headless), where `available()` is false and the tool
 * reports the no-op back to the agent.
 *
 * Methods are synchronous because the underlying VS Code API is synchronous.
 */
export interface InlineCommentProvider {
  /** True when a CommentController is registered (feature available). */
  available(): boolean;
  add(input: {
    absolutePath: string;
    line: number;
    endLine: number;
    body: string;
  }): { threadId: string; resolvedPath: string } | null;
  /** Returns false when no thread matches `threadId`. */
  reply(input: { threadId: string; body: string }): boolean;
  /** Returns false when no thread matches `threadId`. */
  setResolved(input: { threadId: string; resolved: boolean }): boolean;
  list(input: { absolutePath?: string }): InlineCommentThreadView[];
}

const UNAVAILABLE: InlineCommentProvider = {
  available: () => false,
  add: () => null,
  reply: () => false,
  setResolved: () => false,
  list: () => [],
};

let provider: InlineCommentProvider = UNAVAILABLE;

export function setInlineCommentProvider(next: InlineCommentProvider): void {
  provider = next;
}

export const InlineCommentInputSchema = z.strictObject({
  command: z
    .enum(['add', 'reply', 'resolve', 'unresolve', 'list'])
    .describe(
      "add: open a new comment thread on a file range. reply: append a comment to an existing thread. resolve/unresolve: toggle a thread's resolved state. list: read open threads and their comments, including the user's replies.",
    ),
  path: z
    .string()
    .trim()
    .min(1)
    .nullish()
    .describe(
      'add: file the comment anchors to (required). list: restrict to one file (omit for all threads). Workspace-relative or absolute.',
    ),
  line: z
    .int()
    .min(1)
    .nullish()
    .describe('add: 1-based start line the comment anchors to (required).'),
  endLine: z
    .int()
    .min(1)
    .nullish()
    .describe(
      'add: 1-based end line of the range; defaults to the start line.',
    ),
  body: z
    .string()
    .min(1)
    .nullish()
    .describe('add / reply: the comment text (Markdown supported).'),
  threadId: z
    .string()
    .min(1)
    .nullish()
    .describe(
      'reply / resolve / unresolve: the thread id returned by "add" or "list".',
    ),
});

type InlineCommentInput = z.infer<typeof InlineCommentInputSchema>;

/** Render a thread for the agent: a header line plus each comment indented. */
function formatThread(thread: InlineCommentThreadView): string {
  const range =
    thread.line === thread.endLine
      ? `${thread.line}`
      : `${thread.line}-${thread.endLine}`;
  const header = `[${thread.threadId}] ${thread.path}:${range} (${
    thread.resolved ? 'resolved' : 'open'
  })`;
  const comments = thread.comments
    .map((comment) => `  ${comment.author}: ${comment.body}`)
    .join('\n');
  return comments ? `${header}\n${comments}` : header;
}

export class InlineCommentTool extends defineTool({
  name: 'inline_comment',
  description:
    'Leave inline comment threads in the editor via VS Code\'s native Comments UI (gutter bubbles + Comments panel) that the user can reply to and resolve. Commands: "add" opens a thread on a file range, "reply" appends to a thread, "resolve"/"unresolve" toggle a thread\'s state, "list" reads open threads including the user\'s replies. Use this for conversational, resolvable review notes; use the diagnostics tool\'s "add" command for one-off lint-style critique squiggles. Not available outside the VS Code extension host.',
  schema: InlineCommentInputSchema,
}) {
  protected async execute(input: InlineCommentInput): Promise<ToolResult> {
    if (!provider.available()) {
      return executed(
        'Inline comments require the VS Code extension host and are not available in this environment.',
        'Inline comments unavailable',
      );
    }
    switch (input.command) {
      case 'add':
        return this.addThread(input);
      case 'reply':
        return this.reply(input);
      case 'resolve':
        return this.setResolved(input, true);
      case 'unresolve':
        return this.setResolved(input, false);
      case 'list':
        return this.list(input);
    }
  }

  private addThread(input: InlineCommentInput): ToolResult {
    const { path, line, endLine, body } = input;
    if (path == null || line == null || body == null) {
      throw new ToolError('The "add" command requires path, line, and body.');
    }
    if (endLine != null && endLine < line) {
      throw new ToolError('endLine must be greater than or equal to line.');
    }
    try {
      const workingDirectory =
        getRunContextWorkingDirectory(tryUseRunContext());
      const resolved = resolveWorkspaceRelativePath(path, workingDirectory);
      const result = provider.add({
        absolutePath: resolved.absolute,
        line,
        endLine: endLine ?? line,
        body,
      });
      if (!result) {
        throw new ToolError('Failed to create the comment thread.');
      }
      const where = result.resolvedPath || resolved.absolute;
      const summary = `Opened comment thread ${result.threadId} at ${where}:${line}`;
      return executed(
        `${summary}\nThe user can reply or resolve it in the editor; read replies with the "list" command.`,
        summary,
      );
    } catch (error) {
      if (error instanceof ToolError) throw error;
      const detail = toErrorMessage(error);
      log.error(`Failed to add inline comment: ${detail}`);
      throw new ToolError(`Failed to add inline comment: ${detail}`);
    }
  }

  private reply(input: InlineCommentInput): ToolResult {
    const { threadId, body } = input;
    if (threadId == null || body == null) {
      throw new ToolError('The "reply" command requires threadId and body.');
    }
    if (!provider.reply({ threadId, body })) {
      return this.threadNotFound(threadId);
    }
    const summary = `Replied to comment thread ${threadId}`;
    return executed(summary, summary);
  }

  private setResolved(
    input: InlineCommentInput,
    resolved: boolean,
  ): ToolResult {
    const { threadId } = input;
    if (threadId == null) {
      throw new ToolError(
        `The "${resolved ? 'resolve' : 'unresolve'}" command requires threadId.`,
      );
    }
    if (!provider.setResolved({ threadId, resolved })) {
      return this.threadNotFound(threadId);
    }
    const summary = `${resolved ? 'Resolved' : 'Reopened'} comment thread ${threadId}`;
    return executed(summary, summary);
  }

  private list(input: InlineCommentInput): ToolResult {
    let absolutePath: string | undefined;
    if (input.path != null) {
      const workingDirectory =
        getRunContextWorkingDirectory(tryUseRunContext());
      absolutePath = resolveWorkspaceRelativePath(
        input.path,
        workingDirectory,
      ).absolute;
    }
    const threads = provider.list({ absolutePath });
    if (threads.length === 0) {
      return executed(
        input.path
          ? `No comment threads in ${input.path}.`
          : 'No comment threads are open.',
        'No comment threads',
      );
    }
    const summary = formatResultCount(threads.length, 'comment thread');
    return executed(threads.map(formatThread).join('\n\n'), summary);
  }

  private threadNotFound(threadId: string): ToolResult {
    return executed(
      `No comment thread with id "${threadId}". Use the "list" command to see open threads.`,
      'Thread not found',
    );
  }
}
