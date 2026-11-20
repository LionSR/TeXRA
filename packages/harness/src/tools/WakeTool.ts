/**
 * The `wake` tool: a run arranges to be continued at a later time, with a
 * note it writes to itself. The note is one row on the run's own input,
 * queued as the call returns and not read before its time
 * (`FollowUpSender` `self`), so a pending wake is a queued follow-up: it
 * survives the process, is listed and cancelled as one, and is read once,
 * by the run a fiber drives then or by the resume the session starts for it
 * (`submitFollowUp`). The harness decides nothing about what the run does
 * when it reads the note.
 */
// Node imports
import { randomUUID } from 'node:crypto';

// Third-party imports
import { Clock, DateTime, Effect, Option, Schema } from 'effect';

// Local imports
import { wakeNotes } from '@agent/followUp/followUpMessages';
import { Inbox } from '@agent/followUp/Inbox';
import {
  submitFollowUp,
  waitForWakeNotes,
} from '@agent/followUp/ToolUseFollowUp';
import { inRunSession, type RunToolCall } from '@agent/runtime/RunCall';
import { ToolError, type RunId } from '@shared/schemas';
import { conversationOf } from '@tools/codemode/SelfTool';
import { defineTool } from '@tools/core/definition';
import { nullishWithDefault } from '@tools/core/inputSchema';
import {
  formatCompactDuration,
  formatLocalTime,
  previewLabel,
} from '@utils/text/stringUtils';

/** The soonest a wake may be: every wake is a model turn nobody asked for
 *  at that moment, so a run that arranges its next wake each time it wakes
 *  (by mistake, or as a repeating job) takes at most one such turn a minute
 *  for each wake it holds. */
const MIN_DELAY_SECONDS = 60;
/** The wakes one run may hold pending: what bounds the rows it queues and
 *  the turns they start, however it arranges them. */
const MAX_PENDING = 20;

const WakeInputSchema = Schema.Union([
  Schema.Struct({
    // The common call names no command, and a structured-output provider
    // sends an explicit `null` for it: only this branch takes both.
    command: nullishWithDefault(
      Schema.Literal('set'),
      'set',
      'Arrange a wake. Default command.',
    ),
    note: Schema.NonEmptyString.annotate({
      description:
        'What you will read when the time comes. Write it for a reader who remembers nothing of why it was set: what to check or do, and what to do next.',
    }),
    afterSeconds: Schema.optional(
      Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    ).annotate({
      description: `Seconds from now, at least ${MIN_DELAY_SECONDS}. Give this or \`at\`.`,
    }),
    at: Schema.optional(
      Schema.NullOr(
        Schema.String.check(
          Schema.isPattern(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/,
          ),
        ),
      ),
    ).annotate({
      description:
        'A time as ISO 8601 with its UTC offset (`2030-01-31T09:00:00Z`, `2030-01-31T09:00:00+01:00`), without the zone name in brackets that times are shown with. Give this or `afterSeconds`.',
    }),
  }),
  Schema.Struct({
    command: Schema.Literal('list').annotate({
      description: 'Answer the pending wakes.',
    }),
  }),
  Schema.Struct({
    command: Schema.Literal('cancel').annotate({
      description: 'Drop one pending wake.',
    }),
    id: Schema.NonEmptyString.annotate({
      description: 'The id of the wake to drop, as `set` and `list` answer it.',
    }),
  }),
]);
type WakeInput = typeof WakeInputSchema.Type;

/** The run a call's wake continues: its conversation, as `self()` reads it
 *  (`conversationOf`). A program's script has none. */
const wokenRun = Effect.fn('wake.run')(function* (call: RunToolCall) {
  const conversation = yield* conversationOf(call);
  if (conversation === null)
    return yield* new ToolError(
      "A program's run takes no later message, so it cannot be continued later.",
    );
  return conversation.id;
});

/** A command's answer: what it did, then every wake the run has pending. */
const answer = Effect.fn('wake.answer')(function* (
  runId: RunId,
  done: { readonly text?: string; readonly summary: string },
  set?: { readonly id: string; readonly due: number },
) {
  const pending = wakeNotes((yield* (yield* Inbox).read(runId)).followUps);
  const lines =
    pending.length === 0
      ? ['No wake is pending.']
      : [
          `Pending wakes (${pending.length} of at most ${MAX_PENDING}):`,
          ...pending.map(
            ({ id, due, note }) =>
              `- ${id}, due ${formatLocalTime(due)}: ${note}`,
          ),
        ];
  return {
    status: 'executed' as const,
    output: [...(done.text === undefined ? [] : [done.text]), ...lines].join(
      '\n',
    ),
    summary: done.summary,
    value: {
      ...(set !== undefined && { id: set.id, due: formatLocalTime(set.due) }),
      pending: pending.map(({ id, due, note }) => ({
        id,
        due: formatLocalTime(due),
        note,
      })),
    },
  };
});

const runWake = Effect.fn('wake.call')(function* (
  call: RunToolCall,
  input: WakeInput,
) {
  const runId = yield* wokenRun(call);
  const inbox = yield* Inbox;
  if (input.command === 'list')
    return yield* answer(runId, { summary: 'Listed wakes' });
  if (input.command === 'cancel') {
    const dropped = yield* inbox.cancelWake(runId, input.id);
    if (dropped === null)
      return yield* new ToolError(
        `No pending wake has the id ${input.id}. \`list\` answers the pending ones.`,
      );
    // A run no fiber drives (a background script's conversation) waits
    // for the notes it has left, not the one dropped.
    yield* waitForWakeNotes(runId);
    return yield* answer(runId, {
      text: `Cancelled the wake due ${formatLocalTime(dropped.due)}.`,
      summary: 'Cancelled a wake',
    });
  }
  const { note, afterSeconds, at } = input;
  if ((afterSeconds == null) === (at == null))
    return yield* new ToolError('Give `afterSeconds` or `at`, and not both.');
  // The host's clock, read once: the due time is recorded with the call's
  // result, so a script that replays reads the same answer.
  const now = yield* Clock.currentTimeMillis;
  // The schema has made sure `at` names its offset. None: past the last
  // time a date holds.
  const asked = DateTime.make(at ?? now + (afterSeconds ?? 0) * 1000);
  if (Option.isNone(asked))
    return yield* new ToolError('The time asked for is not a valid date.');
  const due = DateTime.toEpochMillis(asked.value);
  if (due - now < MIN_DELAY_SECONDS * 1000)
    return yield* new ToolError(
      `A wake is at least ${MIN_DELAY_SECONDS} seconds from now. Now is ${formatLocalTime(now)}, and it was asked for ${formatLocalTime(due)}.`,
    );
  const held = wakeNotes((yield* inbox.read(runId)).followUps).length;
  if (held >= MAX_PENDING)
    return yield* new ToolError(
      `This run already has ${held} wakes pending, the most it may hold. Cancel one first; \`list\` answers them.`,
    );
  const id = randomUUID();
  const sent = yield* submitFollowUp(
    runId,
    {
      text: note,
      displayText: `Note to self, due ${formatLocalTime(due)}: ${previewLabel(note)}`,
      from: { kind: 'self', due },
      deliveryId: id,
    },
    {},
  );
  if (sent.status === 'failed')
    return yield* new ToolError(`The wake was not arranged: ${sent.message}`);
  return yield* answer(
    runId,
    {
      text: `Arranged: you will be continued at ${formatLocalTime(due)} (${formatCompactDuration(due - now)} from now) with your note. Its id is ${id}.`,
      summary: `Wake arranged for ${formatLocalTime(due)}`,
    },
    { id, due },
  );
});

/** The name of the `wake` tool, which the script tool's description names
 *  to a step that offers it. */
export const WAKE_TOOL_NAME = 'wake';

/** The `wake` tool. */
export const WakeTool = defineTool({
  name: WAKE_TOOL_NAME,
  // A wake starts a turn later, when nobody may be watching: a person, or
  // the grant they gave this run's work, approves the call.
  requiresApproval: true,
  scriptReturns:
    '{ id?: string; due?: string; pending: { id: string; due: string; note: string }[] }',
  description: `Arrange to be continued at a later time, with a note you write to yourself now. The call returns at once; nothing waits. When the time comes the note joins your input, marked as your own note with when you asked for it, when it was due and when it is delivered, and you take a turn from it as you would from a message. What you do then is yours to decide. A repeating job is a wake whose turn arranges the next one.

Commands:
- \`set\` (the default) takes \`note\` and either \`afterSeconds\` or \`at\`, at least ${MIN_DELAY_SECONDS} seconds from now. It answers the wake's \`id\` and \`due\` time. A run holds at most ${MAX_PENDING} pending wakes.
- \`list\` answers the pending wakes.
- \`cancel\` drops the pending wake \`id\` names.

Every command answers the pending wakes after it, as \`pending\`.

The time is kept by the process that holds this project. If none is running when a wake is due, its note is delivered once, late, when one next opens the project. A stop of this run cancels its pending wakes. From a background script the note goes to the conversation the script belongs to. A run that takes no later message (a one-shot run, a program) cannot be continued later, and the call fails.`,
  schema: WakeInputSchema,
  execute: (input: WakeInput) => inRunSession((call) => runWake(call, input)),
});
