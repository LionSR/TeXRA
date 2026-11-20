/**
 * `self(prompt, opts)`: a script's function that runs this agent again, as
 * a child of the call. Forked (the default), the child continues the
 * conversation as it stood when the script started, with `prompt` added to
 * the message that started it (`forkSeed`); fresh, it starts with no earlier
 * conversation, from `prompt` and the conversation's files and memories.
 * Either way `selfTask` frames `prompt` as the one part of the script's work
 * the child does. It is the same agent with
 * the same tools, so nothing is proposed: the user approved the script.
 * It runs on the conversation's model unless the call names one, and its
 * call holds it to the limits every child launch takes (`CHILD_FIELDS`).
 * The default goal strategy is this function in a loop (`builtIn:goal`).
 */
import { Effect, Result, Schema, ScopedRef } from 'effect';

import { forkSeed } from '@agent/runtime/forkRun';
import {
  inRunSession,
  type RunToolCall,
  type ScriptScope,
} from '@agent/runtime/RunCall';
import { getRunRecords } from '@agent/storage/runOwnership';
import {
  childModel,
  childResult,
  failedResult,
} from '@agent/runtime/delegation/AgentTool';
import {
  agentChildRunId,
  countLaunch,
  recoverAgentChild,
  withinLimits,
} from '@agent/runtime/delegation/agentChild';
import { executeSubagentInBand } from '@agent/runtime/delegation/childLaunch';
import { CHILD_FIELDS } from '@agent/runtime/delegation/inputFields';
import {
  childOutputSchema,
  printSubagentProgress,
} from '@agent/runtime/delegation/subagentRun';
import {
  AgentConfigSchema,
  backgroundScriptOf,
  runsScript,
  ToolError,
} from '@shared/schemas';
import { RunHistory, SessionLog } from '@shared/session/runHistory';
import { defineTool } from '@tools/core/definition';
import { nullishWithDefault } from '@tools/core/inputSchema';

const SelfInputSchema = Schema.Struct({
  prompt: Schema.NonEmptyString.annotate({
    description: 'What this run of you works on.',
  }),
  fork: nullishWithDefault(
    Schema.Boolean,
    true,
    'Continue this conversation as it stood when the script started, with `prompt` added to the message that started it; `false` starts with no earlier conversation. Either way the child is told `prompt` is the one part of the work it does.',
  ),
  schema: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  ).annotate({
    description:
      'A JSON Schema object: the run finishes by submitting a value of it, returned as `structured`.',
  }),
  ...CHILD_FIELDS,
});
type SelfInput = typeof SelfInputSchema.Type;

/**
 * The conversation a call's run belongs to: the run itself, in its own
 * turn; for a background script, the conversation it launched from (its
 * recorded parent, whether or not it was since detached), with the call
 * that launched it; null for a program's script, which is its own agent and
 * has none.
 */
export const conversationOf = Effect.fn('conversationOf')(function* ({
  run,
}: Pick<RunToolCall, 'run'>) {
  if (!runsScript(run.config)) return { id: run.runId, launchedBy: null };
  if (backgroundScriptOf(run.config) === null) return null;
  const edge = (yield* (yield* SessionLog).facts(run.runId))?.start?.parent;
  if (edge == null)
    return yield* new ToolError(
      `The script ${run.runId} has no record of the conversation it launched from.`,
    );
  return { id: edge.id, launchedBy: edge.call ?? null };
});

/**
 * The agent `self()` runs again, the conversation its forks copy
 * ({@link conversationOf}), and the commit they cut before. In the caller's
 * own script that is the caller, mid-turn. A background script is its
 * conversation's agent, as that conversation stood when the script
 * started. A program's script is its own agent, with no conversation to
 * fork.
 */
const selfOf = Effect.fn('self.of')(function* (call: RunToolCall) {
  const { run } = call;
  const belongsTo = yield* conversationOf(call);
  if (belongsTo === null)
    return { config: run.config, source: null, before: 0, boundAt: undefined };
  const { id: parent, launchedBy } = belongsTo;
  if (parent === run.runId)
    return {
      config: run.config,
      source: run.runId,
      before: Number.POSITIVE_INFINITY,
      boundAt: undefined,
    };
  const missing = new ToolError(
    `self() needs the conversation the script ${run.runId} launched from, and the call that launched it.`,
  );
  if (launchedBy === null) return yield* missing;
  const { card } = launchedBy;
  const config = yield* getRunRecords(parent).readConfig();
  // The cut is the response that issued the script, not the script's own
  // start, which a full child-run budget can delay past later turns: the
  // one whose call opened the card the script's start names (a provider
  // may reuse a call id, never a card), or, for a call a script of the
  // conversation made, the response that issued that script.
  const conversation = yield* (yield* RunHistory).load(parent);
  const issued = Object.values(conversation?.calls ?? {}).find(
    ({ logId }) => logId === card,
  );
  if (config === null || issued === undefined) return yield* missing;
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
  const { runId: parentId } = run;
  const { config, source, before, boundAt } = yield* selfOf(call);
  if (input.fork && source === null)
    return yield* new ToolError(
      "A program's script has no conversation to fork: call self() with `fork: false`.",
    );
  const name = config.agent;
  const outputSchema = yield* childOutputSchema(input.schema);
  const notify = printSubagentProgress(name, call.emit);
  // An earlier attempt's child answers the call, or continues under its id.
  const recovered = yield* Effect.result(
    recoverAgentChild(call, { notify, limits: input }),
  );
  if (Result.isFailure(recovered)) return failedResult(name, recovered.failure);
  if (recovered.success.kind === 'ended')
    return yield* childResult(call, name, recovered.success, undefined);

  // A model the call names is chosen as `agent()` chooses one: it runs, or
  // the call fails. None named, the child runs on the conversation's.
  const model =
    input.model == null ? undefined : yield* childModel(call, input.model);
  if (model !== undefined && typeof model !== 'string') return model;
  const limited = yield* countLaunch(script, name);
  if (limited !== null) return limited;
  const runId = agentChildRunId(call);
  const { rootUserInstruction: _root, script: _script, ...launch } = config;
  // Forked, the child is born on the conversation's history; fresh, on its
  // framed prompt alone. Either way it is launched, never resumed, so it starts
  // with the grants its parent holds now.
  const launched = yield* Effect.result(
    withinLimits(
      runId,
      input,
      Effect.gen(function* () {
        const fork = input.fork && source !== null;
        const task = selfTask(input.prompt, fork);
        const forked = fork
          ? yield* forkSeed(source, before, runId, task, boundAt)
          : null;
        // The child's first message is its task or its seed, never its
        // parent's launch, so it renders none of the skills that launch
        // activated; forked, it holds the activations its seed copies.
        const { skills: _skills, ...record } = forked?.record ?? {
          ...launch,
          model: (yield* ScopedRef.get(run.model)).modelId,
          instruction: task,
          displayInstruction: input.prompt,
          outputFiles: [],
          launch: undefined,
        };
        return yield* executeSubagentInBand({
          runId,
          parentId,
          configPayload: Schema.decodeUnknownSync(AgentConfigSchema)({
            ...record,
            // A fork on a named model keeps its seed's binding, as a model
            // switch keeps the conversation's: the child's bind rejects a
            // model that conversation's format cannot run on.
            ...(model !== undefined && { model }),
            outputSchema,
            asCaller: true,
          }),
          ...(forked !== null && { seed: forked.seed }),
          parentCall: { callId: call.callId, card: call.logId },
          notify,
        });
      }),
    ),
  );
  return Result.isFailure(launched)
    ? failedResult(name, launched.failure)
    : yield* childResult(call, name, launched.success, undefined);
});

/**
 * The message a run of you that `self()` started reads its prompt in. Without
 * it the child cannot tell its part from the task its parent's script is
 * doing: forked, the request above it is that task; either way it holds the
 * same tools, and a child that takes on the whole task runs it again, its
 * own `self()` calls and the parent's waits included.
 */
function selfTask(prompt: string, forked: boolean): string {
  const context = forked
    ? 'The request above is the one that script is already carrying out; this run does one part of it, the task below.'
    : 'It does one part of the work that script is carrying out, the task below.';
  return `A script of yours started this run of you with self(). ${context} Do only that task, without taking on the rest of the work or starting further self() runs for it, and end with its result.\n\n<task>\n${prompt}\n</task>`;
}

/** The `self` function of a script. */
export const SelfTool = defineTool({
  name: 'self',
  // A resumed call finds the child its earlier attempt launched and takes
  // its result, or resumes it under its own id: it never launches a second one.
  replay: 'safe',
  // A script's calls run beside each other.
  lane: 'own',
  // Offered with the script tool: only a script calls it.
  scriptGlobal: { positional: 'prompt', withScript: true },
  scriptReturns:
    "{ response: string; files: string[]; structured?: unknown; runId: string; outcome: 'completed'; cost: number; spent: number }",
  description: `Run yourself again on a prompt, as a child of this call, and wait for its result: \`{ response, files, structured?, runId, outcome, cost, spent }\`, as \`agent()\` resolves.

Forked (the default), the child continues this conversation as it stood when the script started (the message of the turn that started it, not that turn's work so far), with \`prompt\` added to that message; with \`fork: false\` it starts with no earlier conversation. Either way the child is told \`prompt\` is the one part of the script's work it does, and not to take on the rest. It is you with your tools, and nothing is proposed or approved again. It runs on your model unless \`model\` names another, which is how a different model checks a result with your prompt and tools; a fork takes only a model that can continue this conversation, and a model with another conversation format takes \`fork: false\`.

It rejects with an Error named \`AgentFailed\`, \`TimedOut\` (past \`timeoutMs\`), \`BudgetExceeded\` (the child and the runs it started spent \`maxCostUsd\` before it finished; the cap is read after each reply, so the spend can pass it by the replies then in flight), \`Skipped\` (the user stopped it) or \`ModelUnavailable\`. Call it from a script; called directly, it runs nothing.`,
  schema: SelfInputSchema,
  execute: Effect.fn('SelfTool.execute')(function* (input: SelfInput) {
    return yield* inRunSession((call) =>
      call.script === null
        ? Effect.fail(new ToolError('self() runs only inside a script.'))
        : runSelf(call, input, call.script),
    );
  }),
});
