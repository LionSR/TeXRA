/**
 * `context`: the agent's own view of its run, which it reads (`view`) and
 * edits (`replace`). The view is the messages the next request sends, as
 * the run's state holds them while the response that made the call is
 * dispatched, so its indices end before that response. A `replace` writes
 * nothing itself: its result records the replacement (`ContextReplaceSchema`),
 * the run's state keeps it waiting (`RunFacts.contextEdits`), and the loop
 * writes its `context.edit` at the next request boundary, on the run's
 * fiber (`agentEditsAtBoundary`). So this tool checks every rule an edit
 * must meet against the view it was given: what it accepts applies, and
 * what it refuses changes nothing.
 */
import { Effect, Schema, ScopedRef } from 'effect';

import { inRunSession, type RunToolCall } from '@agent/runtime/RunCall';
import { unpreparedHistory } from '@agent/runtime/providerMessages';
import {
  AGENT_REPLACEMENT_PREFIX,
  agentReplacement,
  COMPACTION_SUMMARY_PREFIX,
} from '@agent/runtime/run/compaction';
import {
  contextTokens,
  estimateMessageTokens,
} from '@agent/runtime/run/contextTokens';
import {
  CONTEXT_TOOL_NAME,
  ContextReplaceSchema,
  NonNegativeIntSchema,
  runsScript,
  ToolError,
  type ToolResult,
} from '@shared/schemas';
import type { HistoryMessage } from '@shared/session/historyTurns';
import { defineTool } from '@tools/core/definition';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { formatCompactTokenCount } from '@utils/text/stringUtils';

const ContextInputSchema = Schema.Union([
  Schema.Struct({
    // An omitted or null `action` is a `view`, the call with no side.
    action: nullishWithDefault(
      Schema.Literal('view'),
      'view',
      'Read the view (the default).',
    ),
  }),
  Schema.Struct({
    action: Schema.Literal('replace'),
    from: NonNegativeIntSchema.annotate({
      description: 'Index of the first message replaced.',
    }),
    to: NonNegativeIntSchema.annotate({
      description: 'Index after the last message replaced.',
    }),
    with: Schema.NonEmptyString.annotate({
      description: 'The text that stands in for those messages.',
    }),
  }),
]);
type ContextInput = typeof ContextInputSchema.Type;

/** How long a message's preview runs. */
const PREVIEW_LENGTH = 120;

/** What one message of the view is, for an agent choosing what to replace. */
type MessageKind = 'text' | 'tool-call' | 'tool-result' | 'summary' | 'system';

/** The text a message holds, its media named, in reading order. */
function messageText(message: HistoryMessage): string {
  switch (message.role) {
    case 'system':
      return message.text;
    case 'user':
      return message.content
        .map((part) => (part.kind === 'text' ? part.text : `[${part.kind}]`))
        .join(' ');
    case 'tool':
      return message.results
        .flatMap(({ content }) =>
          content.map((part) =>
            part.kind === 'text' ? part.text : `[${part.kind}]`,
          ),
        )
        .join(' ');
    case 'assistant':
      return message.content
        .flatMap((part) => {
          if (part.kind === 'message')
            return part.content.map((piece) => piece.text);
          if (part.kind === 'local-call')
            return [`${part.name}(${part.argumentsText})`];
          return [];
        })
        .join(' ');
  }
}

function kindOf(message: HistoryMessage, text: string): MessageKind {
  switch (message.role) {
    case 'system':
      return 'system';
    case 'tool':
      return 'tool-result';
    case 'assistant':
      return message.content.some((part) => part.kind === 'local-call')
        ? 'tool-call'
        : 'text';
    case 'user':
      return text.startsWith(COMPACTION_SUMMARY_PREFIX) ||
        text.startsWith(AGENT_REPLACEMENT_PREFIX)
        ? 'summary'
        : 'text';
  }
}

/** The run's view as this call reads it, or why it has none to edit: a
 *  script's own run has no conversation, only the call it runs. */
const viewOf = Effect.fn('context.viewOf')(function* (call: RunToolCall) {
  if (runsScript(call.run.config))
    return yield* new ToolError(
      "A script's own run has no conversation to read or edit: its one response is the script.",
    );
  return yield* call.state;
});

const view = Effect.fn('context.view')(function* (
  call: RunToolCall,
): Effect.fn.Return<ToolResult, ToolError> {
  const state = yield* viewOf(call);
  const bound = yield* ScopedRef.get(call.run.model);
  const messages = state.messages.map((message, index) => {
    const text = messageText(message);
    const flat = text.replaceAll(/\s+/g, ' ').trim();
    return {
      index,
      role: message.role,
      kind: kindOf(message, text),
      tokens: estimateMessageTokens([message]),
      preview:
        flat.length > PREVIEW_LENGTH
          ? `${flat.slice(0, PREVIEW_LENGTH)}…`
          : flat,
    };
  });
  const value = {
    action: 'view' as const,
    window: bound.config.contextWindow,
    tokens: contextTokens(state),
    messages,
    pending: state.contextEdits.map(({ from, to }) => ({ from, to })),
  };
  const lines = [
    `${messages.length} messages, about ${formatCompactTokenCount(value.tokens)} tokens of a ${formatCompactTokenCount(value.window)} window. Message ${messages.length} is the response that made this call.`,
    ...messages.map(
      (m) =>
        `[${m.index}] ${m.role} ${m.kind} ~${formatCompactTokenCount(m.tokens)}: ${m.preview}`,
    ),
    ...value.pending.map(
      ({ from, to }) => `Replacement already asked for: [${from}, ${to}).`,
    ),
  ];
  return {
    status: 'executed',
    output: lines.join('\n'),
    summary: `${messages.length} messages, ~${formatCompactTokenCount(value.tokens)} tokens`,
    value,
  };
});

const replace = Effect.fn('context.replace')(function* (
  call: RunToolCall,
  { from, to, with: text }: Extract<ContextInput, { action: 'replace' }>,
): Effect.fn.Return<ToolResult, ToolError> {
  const state = yield* viewOf(call);
  const { messages } = state;
  const refused = (why: string) =>
    new ToolError(`Messages [${from}, ${to}) were not replaced: ${why}`);
  if (from >= to)
    return yield* refused('the range is empty; `to` must be above `from`.');
  if (to > messages.length)
    return yield* refused(
      `the view holds messages 0 to ${messages.length - 1}, and message ${messages.length} is the response that made this call, which cannot be replaced.`,
    );
  const overlapping = state.contextEdits.find(
    (asked) => asked.from < to && from < asked.to,
  );
  if (overlapping !== undefined)
    return yield* refused(
      `this response already asked to replace [${overlapping.from}, ${overlapping.to}), which overlaps it. Ranges of one response index the same view and must not overlap.`,
    );
  const replacement = agentReplacement(text);
  const edited = [
    ...messages.slice(0, from),
    replacement,
    ...messages.slice(to),
  ];
  if (unpreparedHistory(edited) !== null)
    return yield* refused(
      'it would separate a tool call from its result. A message that calls tools and the tool results right after it must both be in the range or both outside it.',
    );
  const freed =
    estimateMessageTokens(messages.slice(from, to)) -
    estimateMessageTokens([replacement]);
  const value = Schema.encodeSync(ContextReplaceSchema)({
    action: 'replace',
    from,
    to,
    with: text,
    freed,
  });
  return {
    status: 'executed',
    output: `Messages [${from}, ${to}) will be replaced by your text before your next request, freeing about ${formatCompactTokenCount(freed)} tokens.`,
    summary: `Replace messages ${from}–${to - 1}`,
    value,
  };
});

/** The `context` tool: read and edit the run's own model view. */
export const ContextTool = defineTool({
  name: CONTEXT_TOOL_NAME,
  // It reads the run's state and records a request: running it again
  // answers the same from the same rows.
  replay: 'safe',
  // A barrier: a call reads the replacements its earlier siblings asked
  // for, so they run one at a time, in order.
  lane: 'barrier',
  scriptReturns:
    "{ action: 'view'; window: number; tokens: number; messages: { index: number; role: string; kind: 'text' | 'tool-call' | 'tool-result' | 'summary' | 'system'; tokens: number; preview: string }[]; pending: { from: number; to: number }[] } | { action: 'replace'; from: number; to: number; with: string; freed: number }",
  description: `Read or edit your own context: the messages each of your requests sends.

- view: each message with its index, role, kind, estimated tokens and a preview; the window size and the tokens in use; and the replacements this response already asked for.
- replace: messages [from, to) are replaced, before your next request, by one message holding \`with\`. Indices are the view's, as this response was sent; ranges asked for in one response must not overlap. The range ends at or before the response that makes the call, and keeps each tool call with its results.

The replaced messages stay in the stored history: the person still sees them, and the executions tool, where offered, reads them back (/executions/current/conversation). A replacement ends prompt-cache reuse from its first message on, and any provider-side continuation, so the next request pays full input price for everything after that point. Keep what the user asked of you, in substance.`,
  schema: ContextInputSchema,
  execute: (input: ContextInput) =>
    inRunSession((call) =>
      input.action === 'replace' ? replace(call, input) : view(call),
    ),
});
