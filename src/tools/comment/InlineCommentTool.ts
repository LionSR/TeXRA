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
 * extension host and backed by the VS Code CommentController. Hosts without
 * one (CLI / desktop) never reach the tool: its `unavailableHosts` list drops
 * `inline_comment` from their agent rosters.
 *
 * Methods are synchronous because the underlying VS Code API is synchronous.
 */
export interface InlineCommentProvider {
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

let provider: InlineCommentProvider | undefined;

export function setInlineCommentProvider(next: InlineCommentProvider): void {
  provider = next;
}

/**
 * Resolve the host-injected provider, throwing when none was wired. The throw
 * is intentional: `unavailableHosts` already keeps `inline_comment` out of the
 * CLI and desktop rosters, so reaching the tool with no provider means a host
 * skipped the registration — a startup bug that must name itself rather than
 * report a plausible no-op back to the agent.
 */
function requireProvider(): InlineCommentProvider {
  if (!provider) {
    throw new ToolError(
      'Inline comments are unavailable: no host called setInlineCommentProvider() during startup. Only the VS Code extension host wires this tool.',
    );
  }
  return provider;
}

const THREAD_ID_DESCRIPTION = 'The thread id returned by "add" or "list".';
const COMMENT_BODY_DESCRIPTION = 'The comment text (Markdown supported).';

// Branches use looseObject (not strictObject): provider conversion flattens the
// discriminated union into one advertised object and OpenAI-compatible providers
// null-fill the properties belonging to the other commands. See AGENTS.md
// "Tool input schemas".
const InlineCommentInputSchema = z.discriminatedUnion('command', [
  z
    .looseObject({
      command: z
        .literal('add')
        .describe('Open a new comment thread on a file range.'),
      path: z.string().trim().min(1).describe(
        // Provider conversion advertises one `path` for all commands and keeps
        // this first-declared branch's description (flattenTopLevelUnion), so
        // it must also carry the list command's guidance.
        'File the comment anchors to (add), or the file to restrict to (list; omit for all threads). Workspace-relative or absolute.',
      ),
      line: z
        .int()
        .min(1)
        .describe('1-based start line the comment anchors to.'),
      endLine: z
        .int()
        .min(1)
        .nullish()
        .describe('1-based end line of the range; defaults to the start line.'),
      body: z.string().min(1).describe(COMMENT_BODY_DESCRIPTION),
    })
    .refine((data) => data.endLine == null || data.endLine >= data.line, {
      message: 'endLine must be greater than or equal to line.',
      path: ['endLine'],
    }),
  z.looseObject({
    command: z
      .literal('reply')
      .describe('Append a comment to an existing thread.'),
    threadId: z.string().min(1).describe(THREAD_ID_DESCRIPTION),
    body: z.string().min(1).describe(COMMENT_BODY_DESCRIPTION),
  }),
  z.looseObject({
    command: z.literal('resolve').describe('Mark a thread resolved.'),
    threadId: z.string().min(1).describe(THREAD_ID_DESCRIPTION),
  }),
  z.looseObject({
    command: z.literal('unresolve').describe('Reopen a resolved thread.'),
    threadId: z.string().min(1).describe(THREAD_ID_DESCRIPTION),
  }),
  z.looseObject({
    command: z
      .literal('list')
      .describe(
        "Read open threads and their comments, including the user's replies.",
      ),
    path: z
      .string()
      .trim()
      .min(1)
      .nullish()
      .describe(
        'Restrict to one file (omit for all threads). Workspace-relative or absolute.',
      ),
  }),
]);

type InlineCommentInput = z.infer<typeof InlineCommentInputSchema>;
type AddCommentInput = Extract<InlineCommentInput, { command: 'add' }>;
type ReplyCommentInput = Extract<InlineCommentInput, { command: 'reply' }>;
type SetResolvedInput = Extract<
  InlineCommentInput,
  { command: 'resolve' | 'unresolve' }
>;
type ListCommentInput = Extract<InlineCommentInput, { command: 'list' }>;

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
  // Requires the VS Code Comments UI.
  unavailableHosts: ['cli', 'desktop'],
  description:
    'Leave inline comment threads in the editor via VS Code\'s native Comments UI (gutter bubbles + Comments panel) that the user can reply to and resolve. Commands: "add" opens a thread on a file range, "reply" appends to a thread, "resolve"/"unresolve" toggle a thread\'s state, "list" reads open threads including the user\'s replies. Use this for conversational, resolvable review notes; use the diagnostics tool\'s "add" command for one-off lint-style critique squiggles. Not available outside the VS Code extension host.',
  schema: InlineCommentInputSchema,
}) {
  protected async execute(input: InlineCommentInput): Promise<ToolResult> {
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

  private addThread(input: AddCommentInput): ToolResult {
    const { path, line, endLine, body } = input;
    try {
      const workingDirectory =
        getRunContextWorkingDirectory(tryUseRunContext());
      const resolved = resolveWorkspaceRelativePath(path, workingDirectory);
      const result = requireProvider().add({
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

  private reply(input: ReplyCommentInput): ToolResult {
    const { threadId, body } = input;
    if (!requireProvider().reply({ threadId, body })) {
      return this.threadNotFound(threadId);
    }
    const summary = `Replied to comment thread ${threadId}`;
    return executed(summary, summary);
  }

  private setResolved(input: SetResolvedInput, resolved: boolean): ToolResult {
    const { threadId } = input;
    if (!requireProvider().setResolved({ threadId, resolved })) {
      return this.threadNotFound(threadId);
    }
    const summary = `${resolved ? 'Resolved' : 'Reopened'} comment thread ${threadId}`;
    return executed(summary, summary);
  }

  private list(input: ListCommentInput): ToolResult {
    let absolutePath: string | undefined;
    if (input.path != null) {
      const workingDirectory =
        getRunContextWorkingDirectory(tryUseRunContext());
      absolutePath = resolveWorkspaceRelativePath(
        input.path,
        workingDirectory,
      ).absolute;
    }
    const threads = requireProvider().list({ absolutePath });
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
