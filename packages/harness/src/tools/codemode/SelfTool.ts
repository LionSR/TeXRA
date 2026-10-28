/**
 * `self(prompt, opts)`: a script's function that runs this agent again, as
 * a child of the call. Forked (the default), the child continues the
 * conversation as it stood when the script started, with `prompt` added to
 * the message that started it (`forkSeed`); fresh, it starts from `prompt` alone with the
 * conversation's files and memories. Either way it is the same agent with
 * the same tools, so nothing is proposed: the user approved the script.
 * The goal is this function in a loop (`goalScript`).
 */
import { Effect, Result, Schema, SynchronizedRef } from 'effect';

import { scriptChildBudget } from '@agent/runtime/childRunBudget';
import { forkSeed } from '@agent/runtime/forkRun';
import {
  requireToolRun,
  type RunToolCall,
  type ScriptScope,
} from '@agent/runtime/RunCall';
import { getRunRecords } from '@agent/storage/runRecords';
import {
  AgentConfigSchema,
  type DispatchFacts,
  qualifyAggregateId,
  ToolError,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { defineTool } from '@tools/core/definition';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { errorResult } from '@tools/core/result';
import { childResult, failedResult } from '@tools/delegation/AgentTool';
import {
  agentChildRunId,
  countLaunch,
  recoverAgentChild,
} from '@tools/delegation/agentChild';
import { executeSubagentInBand } from '@tools/delegation/inBandSubagentRun';
import { describeSubagentProgress } from '@tools/delegation/subagentRun';
import { normalizeStructuredOutputSchema } from '@tools/structuredOutput';
import { toErrorMessage } from '@utils/errors/errorMessage';

const SelfInputSchema = Schema.Struct({
  prompt: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'What this run of you works on.',
  }),
  fork: nullishWithDefault(
    Schema.Boolean,
    true,
    'Continue this conversation as it stood when the script started, with `prompt` added to the message that started it; `false` starts from `prompt` alone.',
  ),
  schema: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  ).annotate({
    description:
      'A JSON Schema object: the run finishes by submitting a value of it, returned as `structured`.',
  }),
  label: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: 'A short title for the call’s card.',
  }),
});
type SelfInput = typeof SelfInputSchema.Type;

/**
 * The agent `self()` runs again, the conversation its forks copy, and the
 * commit they cut before. In the caller's own script that is the caller,
 * mid-turn. A background script is its conversation's agent: the
 * conversation it launched from (its recorded parent, whether or not it was
 * since detached) as it stood when the script started. A task's script is
 * its own agent, with no conversation to fork.
 */
const selfOf = Effect.fn('self.of')(function* (call: RunToolCall) {
  const { run } = call;
  const { script } = run.config;
  if (script == null)
    return {
      config: run.config,
      source: run.runId,
      before: Number.POSITIVE_INFINITY,
      boundAt: undefined,
    };
  if (script.kind !== 'background')
    return { config: run.config, source: null, before: 0, boundAt: undefined };
  const start = (yield* run.session.log.records(run.runId)).find(
    (row) => row.type === 'run.start',
  );
  const missing = new ToolError(
    `self() needs the conversation the script ${run.runId} launched from, and the call that launched it.`,
  );
  const edge = start?.type === 'run.start' ? start.parent : null;
  if (edge?.call == null) return yield* Effect.fail(missing);
  const { id: parent } = edge;
  const { card } = edge.call;
  const config = yield* getRunRecords(run.session, parent).readConfig();
  // The cut is the response that issued the script, not the script's own
  // start, which a full child-run budget can delay past later turns: the
  // one whose call opened the card the script's start names (a provider
  // may reuse a call id, never a card), or, for a call a script of the
  // conversation made, the response that issued that script.
  const rows = yield* run.session.log.rows(qualifyAggregateId('run', parent), [
    'model.message',
    'script.call',
  ]);
  const issues = (
    row: (typeof rows)[number],
    ids: (call: DispatchFacts) => boolean,
  ) =>
    row.type === 'model.message' &&
    row.payload.kind === 'response' &&
    row.payload.calls.some(ids);
  const at = rows.findIndex(
    (row) =>
      issues(row, ({ logId }) => logId === card) ||
      (row.type === 'script.call' && row.payload.logId === card),
  );
  const owner = rows[at];
  const issued =
    owner?.type === 'script.call'
      ? rows
          .slice(0, at)
          .findLast((row) =>
            issues(row, ({ callId }) => callId === owner.payload.scriptCallId),
          )
      : owner;
  if (config === null || issued === undefined)
    return yield* Effect.fail(missing);
  return {
    config,
    source: parent,
    before: issued.commit,
    boundAt: issued.seq,
  };
});

const runSelf = Effect.fn('self.call')(function* (
  call: RunToolCall,
  input: SelfInput,
  script: ScriptScope,
) {
  const { run } = call;
  const { session, runId: parentRunId } = run;
  const { config, source, before, boundAt } = yield* selfOf(call);
  if (input.fork && source === null)
    return errorResult(
      "A task's script has no conversation to fork: call self() with `fork: false`.",
    );
  const name = config.agent;
  const outputSchema =
    input.schema == null
      ? undefined
      : yield* Effect.try({
          try: () =>
            normalizeStructuredOutputSchema(input.schema ?? {}).jsonSchema,
          catch: (error) =>
            new ToolError(
              `\`schema\` is not a supported object-root JSON Schema: ${toErrorMessage(error)}`,
            ),
        });
  const notify = (update: SubagentProgressUpdate): void => {
    const line = describeSubagentProgress(name, update);
    if (line) call.emit(`${line}\n`);
  };
  // An earlier attempt's child answers the call, or continues under its id.
  const recovered = yield* Effect.result(
    recoverAgentChild(call, { notify, running: (work) => work }),
  );
  if (Result.isFailure(recovered)) return failedResult(name, recovered.failure);
  if (recovered.success.kind === 'ended')
    return yield* childResult(call, name, recovered.success, undefined);

  const limited = yield* countLaunch(script, name);
  if (limited !== null) return limited;
  const runId = agentChildRunId(call);
  const { rootUserInstruction: _root, script: _script, ...launch } = config;
  // Forked, the child is born on the conversation's history; fresh, on the
  // prompt alone. Either way it is launched, never resumed, so it starts
  // with the grants its parent holds now.
  const launched = yield* Effect.result(
    Effect.gen(function* () {
      const forked =
        input.fork && source !== null
          ? yield* forkSeed(
              session,
              source,
              before,
              runId,
              input.prompt,
              boundAt,
            )
          : null;
      return yield* executeSubagentInBand({
        session,
        runId,
        parentRunId,
        configPayload: Schema.decodeUnknownSync(AgentConfigSchema)({
          ...(forked?.record ?? {
            ...launch,
            model: (yield* SynchronizedRef.get(run.model)).modelId,
            instruction: input.prompt,
            displayInstruction: null,
            outputFiles: [],
            cli: null,
          }),
          script: null,
          outputSchema: outputSchema ?? null,
          asCaller: true,
        }),
        ...(forked !== null && { seed: forked.seed }),
        parentCall: { callId: call.callId, card: call.logId },
        notify,
      });
    }),
  );
  return Result.isFailure(launched)
    ? failedResult(name, launched.failure)
    : yield* childResult(call, name, launched.success, undefined);
});

/** The `self` function of a script. */
export const SelfTool = defineTool({
  name: 'self',
  // A resumed call finds the child its earlier attempt launched and takes
  // its result, or resumes it under its own id: it never launches a second one.
  replay: 'safe',
  // A script's calls run beside each other, held to the child-run budget.
  lane: 'own',
  // Offered with the script tool: only a script calls it.
  scriptGlobal: { positional: 'prompt', withScript: true },
  scriptReturns:
    "{ response: string; files: string[]; structured?: unknown; runId: string; outcome: 'completed'; cost: number; spent: number }",
  slow: true,
  description: `Run yourself again on a prompt, as a child of this call, and wait for its result: \`{ response, files, structured?, runId, outcome, cost, spent }\`, as \`agent()\` resolves.

Forked (the default), the child continues this conversation as it stood when the script started (the message of the turn that started it, not that turn's work so far), with \`prompt\` added to that message; with \`fork: false\` it starts from \`prompt\` alone. It is you with your tools and model: nothing is proposed or approved again. It rejects with an Error named \`AgentFailed\` or \`Skipped\` (the user stopped it). Call it from a script; called directly, it runs nothing.`,
  schema: SelfInputSchema,
  execute: Effect.fn('SelfTool.execute')(function* (input: SelfInput) {
    const call = yield* requireToolRun('self');
    const { script } = call;
    if (script === null)
      return errorResult('self() runs only inside a script.');
    const budget = yield* scriptChildBudget(call.env.roots, script);
    return yield* budget.withPermits(1)(runSelf(call, input, script));
  }),
});
