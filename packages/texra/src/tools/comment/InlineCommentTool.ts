// Third-party imports
import { formatResultCount } from '@texra-ai/harness/transcript';
import { Context, Effect, Option, Schema } from 'effect';
import {
  defineTool,
  ToolContext,
  withLogChannel,
  type ToolResult,
} from '@texra-ai/harness';

// Internal imports
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import {
  resolveToolPath,
  executed,
  ToolError,
} from '@texra-ai/harness/plugins';

// Local file imports

const CHANNEL = 'InlineCommentTool';

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
 * `inline_comment` from their agent lists.
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

/**
 * The host's inline-comment provider, the `core` plugin's process layer on
 * the one host that has a Comments UI (`texraPlugins({ inlineComments })`).
 * A host without one passes none, and the tool reads the absence rather
 * than a module slot's `undefined`.
 */
export class InlineComments extends Context.Service<
  InlineComments,
  InlineCommentProvider
>()('@texra/tools/InlineComments') {}

/**
 * Resolve the host's provider, failing when the host serves none. The failure
 * is intentional: `unavailableHosts` already keeps `inline_comment` out of the
 * CLI and desktop agent lists, so reaching the tool without a provider means the
 * VS Code host skipped it — a startup bug that must name itself rather than
 * report a plausible no-op back to the agent.
 */
const requireProvider = Effect.gen(function* () {
  const provider = yield* Effect.serviceOption(InlineComments);
  if (Option.isNone(provider)) {
    return yield* Effect.fail(
      new ToolError(
        'Inline comments are unavailable: this host serves no inline-comment provider. Only the VS Code extension host wires this tool.',
      ),
    );
  }
  return provider.value;
});

const THREAD_ID_DESCRIPTION = 'The thread id returned by "add" or "list".';
const COMMENT_BODY_DESCRIPTION = 'The comment text (Markdown supported).';

const InlineCommentInputSchema = Schema.Union([
  // Built here rather than passed as a shape: the branch carries a
  // cross-field check.
  Schema.StructWithRest(
    Schema.Struct({
      command: Schema.Literal('add').annotate({
        description: 'Open a new comment thread on a file range.',
      }),
      path: Schema.Trim.check(Schema.isMinLength(1)).annotate({
        description:
          // Provider conversion advertises one `path` for all commands and keeps
          // this first-declared branch's description (flattenTopLevelUnion), so
          // it must also carry the list command's guidance.
          'File the comment anchors to (add), or the file to restrict to (list; omit for all threads). Workspace-relative or absolute.',
      }),
      line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: '1-based start line the comment anchors to.',
      }),
      endLine: Schema.optional(
        Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      ).annotate({
        description:
          '1-based end line of the range; defaults to the start line.',
      }),
      body: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: COMMENT_BODY_DESCRIPTION,
      }),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ).check(
    Schema.makeFilter(
      (data) => data.endLine == null || data.endLine >= data.line,
      {
        message: 'endLine must be greater than or equal to line.',
        path: ['endLine'],
      },
    ),
  ),
  Schema.StructWithRest(
    Schema.Struct({
      command: Schema.Literal('reply').annotate({
        description: 'Append a comment to an existing thread.',
      }),
      threadId: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: THREAD_ID_DESCRIPTION,
      }),
      body: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: COMMENT_BODY_DESCRIPTION,
      }),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      command: Schema.Literal('resolve').annotate({
        description: 'Mark a thread resolved.',
      }),
      threadId: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: THREAD_ID_DESCRIPTION,
      }),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      command: Schema.Literal('unresolve').annotate({
        description: 'Reopen a resolved thread.',
      }),
      threadId: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: THREAD_ID_DESCRIPTION,
      }),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      command: Schema.Literal('list').annotate({
        description:
          "Read open threads and their comments, including the user's replies.",
      }),
      path: Schema.optional(
        Schema.NullOr(Schema.Trim.check(Schema.isMinLength(1))),
      ).annotate({
        description:
          'Restrict to one file (omit for all threads). Workspace-relative or absolute.',
      }),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
]);

type InlineCommentInput = typeof InlineCommentInputSchema.Type;
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

/**
 * Wrap an unexpected failure from path resolution or the provider. A
 * `ToolError` already names itself and passes through unchanged.
 */
function addCommentFailure(error: unknown): Effect.Effect<never, ToolError> {
  if (error instanceof ToolError) return Effect.fail(error);
  const detail = toErrorMessage(error);
  return Effect.logError(`Failed to add inline comment: ${detail}`).pipe(
    withLogChannel(CHANNEL),
    Effect.andThen(
      Effect.fail(new ToolError(`Failed to add inline comment: ${detail}`)),
    ),
  );
}

function threadNotFound(threadId: string): ToolResult {
  return executed(
    `No comment thread with id "${threadId}". Use the "list" command to see open threads.`,
    'Thread not found',
  );
}

const addThread = Effect.fn('InlineCommentTool.addThread')(function* (
  input: AddCommentInput,
) {
  const call = yield* ToolContext;
  const { path, line, endLine, body } = input;
  const resolved = yield* resolveToolPath(call.env, path).pipe(
    Effect.catch(addCommentFailure),
  );
  const provider = yield* requireProvider;
  const result = yield* Effect.try({
    try: () =>
      provider.add({
        absolutePath: resolved.absolute,
        line,
        endLine: endLine ?? line,
        body,
      }),
    catch: ensureError,
  }).pipe(Effect.catch(addCommentFailure));
  if (!result) {
    return yield* Effect.fail(
      new ToolError('Failed to create the comment thread.'),
    );
  }
  const where = result.resolvedPath || resolved.absolute;
  const summary = `Opened comment thread ${result.threadId} at ${where}:${line}`;
  return executed(
    `${summary}\nThe user can reply or resolve it in the editor; read replies with the "list" command.`,
    summary,
  );
});

const replyToThread = Effect.fn('InlineCommentTool.reply')(function* (
  input: ReplyCommentInput,
) {
  const { threadId, body } = input;
  if (!(yield* requireProvider).reply({ threadId, body })) {
    return threadNotFound(threadId);
  }
  const summary = `Replied to comment thread ${threadId}`;
  return executed(summary, summary);
});

const setThreadResolved = Effect.fn('InlineCommentTool.setResolved')(function* (
  input: SetResolvedInput,
  resolved: boolean,
) {
  const { threadId } = input;
  if (!(yield* requireProvider).setResolved({ threadId, resolved })) {
    return threadNotFound(threadId);
  }
  const summary = `${resolved ? 'Resolved' : 'Reopened'} comment thread ${threadId}`;
  return executed(summary, summary);
});

const listThreads = Effect.fn('InlineCommentTool.list')(function* (
  input: ListCommentInput,
) {
  const call = yield* ToolContext;
  const absolutePath =
    input.path == null
      ? undefined
      : (yield* resolveToolPath(call.env, input.path ?? undefined)).absolute;
  const threads = (yield* requireProvider).list({ absolutePath });
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
});

function inlineComment(
  input: InlineCommentInput,
): Effect.Effect<ToolResult, ToolError, ToolContext> {
  switch (input.command) {
    case 'add':
      return addThread(input);
    case 'reply':
      return replyToThread(input);
    case 'resolve':
      return setThreadResolved(input, true);
    case 'unresolve':
      return setThreadResolved(input, false);
    case 'list':
      return listThreads(input);
  }
}

export const InlineCommentTool = defineTool({
  name: 'inline_comment',
  // Requires the VS Code Comments UI.
  unavailableHosts: ['cli', 'desktop', 'sdk'],
  description:
    'Leave inline comment threads in the editor via VS Code\'s native Comments UI (gutter bubbles + Comments panel) that the user can reply to and resolve. Commands: "add" opens a thread on a file range, "reply" appends to a thread, "resolve"/"unresolve" toggle a thread\'s state, "list" reads open threads including the user\'s replies. Use this for conversational, resolvable review notes; use the diagnostics tool\'s "add" command for one-off lint-style critique squiggles. Not available outside the VS Code extension host.',
  schema: InlineCommentInputSchema,
  execute: inlineComment,
});
