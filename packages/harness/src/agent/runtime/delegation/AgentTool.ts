/**
 * The `agent` tool: run a named agent as a child of the calling run, with
 * its prompt and its own tools. `launchChildAgent` is the launch it shares
 * with a plugin's task tools (`launchesTasks`), which open the same child on
 * the plugin's recipe. A script's `agent` calls share one approval request
 * showing its source; a direct call proposes itself. A completed awaited
 * call is reused by a later call with the same key in the same run or a
 * background script run of it, and a call cut short finds the child its
 * attempt launched (`agentChild.ts`). When a call waits and what it returns
 * is in the tool's description.
 */

// Third-party imports
import { Effect, Result, Schema, ScopedRef } from 'effect';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { isTrustedScript } from '@agent/core/definition/RunRecord';
import { readRecipeResult } from '@agent/runtime/recipeResult';
import { formatSubagentDelivery } from '@agent/runtime/subagentResults';
import { getRunRecords } from '@agent/storage/runRecords';
import { RunCall, noLaterTurn, requireToolRun } from '@agent/runtime/RunCall';
import { decisionOf } from '@agent/runtime/requests';
import type { RunToolCall, ScriptScope } from '@agent/runtime/RunCall';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import {
  AGENT_SOURCE,
  AgentProposalSchema,
  type AgentProposal,
  toJsonValue,
  ToolError,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
  type ToolResult,
} from '@shared/schemas';
import { attemptRequests, callRequestId } from '@shared/session/inFlight';
import {
  RunHistory,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';
import { defineTool, type DefinedTool } from '@tools/core/definition';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { errorResult, executed } from '@tools/core/result';
import { normalizeStructuredOutputSchema } from '@tools/structuredOutput';
import { sha256 } from '@utils/core/idHash';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  agentChildRunId,
  countLaunch,
  earlierChild,
  fingerprint,
  recoverAgentChild,
  reusable,
  treeCostOf,
} from './agentChild';
import { selectAvailableDelegationModel } from './delegationAvailability';
import { executeSubagentInBand } from './childLaunch';
import {
  memoriesField,
  personaField,
  rejectUnusableWorkingDirectory,
  resolveInvocationFileList,
  withToolUseSubagentHandoffInstruction,
  workingDirectoryField,
} from './inputFields';
import { AgentRequest, decideDelegation, requireAgent } from './proposalFlow';
import {
  delegatedChildGrants,
  describeSubagentProgress,
  launchDetachedSubagent,
} from './subagentRun';

/** The call's `timeoutMs` passed: interrupting the wait stopped the child. */
class AgentTimedOut extends Schema.TaggedError<AgentTimedOut>()(
  'AgentTimedOut',
  { timeoutMs: Schema.Number },
) {}

/** A list of file paths, empty when the call names none. */
export const fileList = (
  description: string,
): ReturnType<typeof nullishWithDefault<Schema.$Array<Schema.String>>> =>
  nullishWithDefault(Schema.Array(Schema.String), [], description);

/** The fields that name what an `agent` call runs and with which model. */
const LAUNCH_FIELDS = {
  prompt: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      'The task, in plain prose. Name the files it concerns and copy every constraint the agent must follow: it does not see your conversation.',
  }),
  agentName: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'The agent to run. It works with its own tools.',
  }),
  persona: personaField,
  model: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      'Model reference, `@effort` suffix allowed (`@low` … `@max`, `@none`). Defaults to your current model when available.',
  }),
  schema: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  ).annotate({
    description:
      'A JSON Schema object: the agent finishes by submitting a value of it, returned as `structured`.',
  }),
  mediaFiles: fileList(
    'Images, figures, PDFs or audio attached to the prompt.',
  ),
};

/** The fields every child launch takes beside its own: memories, the call's
 *  reuse id and card label, its time limit, and whether a script waits. */
export const CALL_FIELDS = {
  memories: memoriesField,
  working_directory: workingDirectoryField,
  id: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      'Tells apart two otherwise identical calls: a completed call is reused by a later one with the same prompt, options and files.',
  }),
  label: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description: 'A short title for the call’s card.',
  }),
  timeoutMs: Schema.optional(
    Schema.NullOr(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)).check(
        Schema.isLessThanOrEqualTo(24 * 60 * 60 * 1000),
      ),
    ),
  ).annotate({
    description: 'Stops the agent after this many milliseconds: `TimedOut`.',
  }),
  background: Schema.optional(Schema.NullOr(Schema.Boolean)).annotate({
    description:
      'In a script: return `{ runId }` at once; the result arrives as a follow-up. A direct call always runs in the background, except in a one-shot run.',
  }),
};
const AgentInputSchema = Schema.Struct({ ...LAUNCH_FIELDS, ...CALL_FIELDS });
type AgentInput = typeof AgentInputSchema.Type;

/**
 * One child launch as the shared core runs it: the agent and its prompt,
 * and what the child is. A chat (`task: null`) may ask for a value of
 * `schema` and attaches `mediaFiles` to its prompt. A task opens on what
 * the launching plugin builds for the approved agent (`configFor`: its
 * recipe and outputs, null for an agent with no task block) and works over
 * `files` with `options`, as its proposal says. `tool` names the launching
 * tool in its reuse key and its copy.
 */
export type ChildLaunch = {
  readonly tool: string;
  readonly agentName: string;
  /** An agent the call defines, named `agentName`: no catalog entry. */
  readonly persona?: AgentProposal['persona'];
  readonly prompt: string;
  readonly model: string | null | undefined;
  readonly memories: readonly string[];
  readonly workingDirectory: string | null | undefined;
  readonly id: string | null | undefined;
  readonly timeoutMs: number | null | undefined;
  readonly background: boolean | null | undefined;
} & (
  | {
      readonly task: null;
      readonly schema: Record<string, unknown> | null | undefined;
      readonly mediaFiles: readonly string[];
    }
  | {
      readonly task: {
        readonly configFor: (
          chosen: AgentProposal,
        ) => Pick<AgentConfig, 'script' | 'outputFiles'> | null;
        readonly options: NonNullable<AgentProposal['options']>;
      };
      readonly files: {
        readonly inputFiles: readonly string[];
        readonly contextFiles: readonly string[];
        readonly mediaFiles: readonly string[];
        readonly outputFiles: readonly string[];
      };
    }
);

/**
 * One request shared by a script's `agent` calls and all its attempts
 * (attempt 0), recovered from rows after restart. A stop cancels it, and
 * the next request takes the next ordinal.
 */
const scriptRequest = Effect.fn('AgentTool.scriptRequest')(
  function* (call: RunToolCall, script: ScriptScope, proposal: AgentProposal) {
    const { runId } = call.run;
    const shared = {
      responseId: call.responseId,
      callId: script.callId,
      attempt: 0,
    };
    const from = (yield* SessionLog).now();
    const state = yield* (yield* RunHistory).load(runId);
    const { raised, own } = attemptRequests(state?.requests ?? {}, shared);
    if (own?.request.decision === null)
      // A session that closes first decides nothing: the next resume asks.
      return yield* decisionOf(runId, own.requestId, from).pipe(
        Effect.map((row) => row.decision),
        Effect.catch((cause) =>
          Effect.logWarning(
            `The script's agent request ${own.requestId} closed without a decision; the call stays in flight and the next resume asks again.`,
          ).pipe(
            Effect.annotateLogs({ data: cause }),
            Effect.andThen(Effect.interrupt),
          ),
        ),
      );
    if (own !== null) return own.request.decision;
    const calls = yield* script.calls;
    return yield* call.requests
      .open({
        kind: 'proposal',
        data: {
          requestId: callRequestId(shared, raised + 1),
          allowBypass: (yield* RunCall)?.hook !== 'ask',
          runId,
          ...proposal,
          script: {
            title: script.title,
            source: script.source,
            calls: calls.map(({ toolName, input }) => ({
              toolName,
              // A tool the preview does not know shows its arguments.
              preview:
                deriveToolInputPreview(toolName, input) ||
                truncateWithEllipsis(JSON.stringify(input) ?? '', 200),
            })),
          },
        },
      })
      .pipe(Effect.map(({ decision }) => decision));
  },
  (effect, call) => Effect.provide(effect, call.session),
);

/** What an ended child becomes for its call: its envelope (a recipe's read
 *  through its block), or the error a script's `await` throws for it. */
export const childResult = Effect.fn('AgentTool.childResult')(function* (
  call: RunToolCall,
  agentName: string,
  { runId, result }: { readonly runId: RunId; readonly result: RunEnd },
  key: string | undefined,
) {
  if (result.outcome === 'cancelled')
    return errorResult(
      `The agent run ${runId} for '${agentName}' was stopped, so this call was skipped.`,
      {
        name: 'Skipped',
        summary: `Skipped '${agentName}'`,
      },
    );
  if (result.outcome !== 'completed')
    return errorResult(
      `The agent run ${runId} for '${agentName}' ended ${result.outcome}${result.error?.message ? `: ${result.error.message}` : '.'}`,
      { name: 'AgentFailed', summary: `'${agentName}' failed` },
    );
  const config = yield* getRunRecords(runId).readConfig();
  const view = yield* (yield* SessionViewAccess).read([]);
  const recipe = yield* readRecipeResult(
    config,
    result.output,
    runId,
    call.env.roots,
  );
  return {
    ...executed(
      formatSubagentDelivery(agentName, result, { runId, recipe }),
      `Completed '${agentName}'`,
    ),
    value: toJsonValue({
      ...result.output,
      ...(recipe !== undefined && { changes: recipe.changes }),
      runId,
      outcome: result.outcome,
      cost: treeCostOf(view, runId),
      spent: treeCostOf(view, call.run.runId),
    }),
    ...(key !== undefined && { reuseKey: key }),
  };
});

/** One call, launched over its call's session. */
export const launchChildAgent = Effect.fn('AgentTool.call')(function* (
  launch: ChildLaunch,
) {
  const call = yield* requireToolRun(launch.tool);
  return yield* agentCall(call, launch).pipe(Effect.provide(call.session));
});

/** A child's run failed the call: timed out, or ended without an answer. */
export function failedResult(agentName: string, error: Error): ToolResult {
  if (error instanceof AgentTimedOut)
    return errorResult(
      `'${agentName}' did not finish within ${error.timeoutMs} ms; its run was stopped.`,
      { name: 'TimedOut', summary: `'${agentName}' timed out` },
    );
  return errorResult(toErrorMessage(error), {
    name: 'AgentFailed',
    summary: `'${agentName}' failed`,
  });
}

const agentCall = Effect.fn('AgentTool.agentCall')(function* (
  call: RunToolCall,
  launch: ChildLaunch,
) {
  const { run } = call;
  const script = call.script ?? undefined;
  const { runId: parentRunId } = run;
  const { task, persona } = launch;
  // A chat's files are the media on its prompt; a task names its four lists.
  const files =
    launch.task === null
      ? {
          inputFiles: [],
          contextFiles: [],
          mediaFiles: launch.mediaFiles,
          outputFiles: [],
        }
      : launch.files;
  const agent =
    persona == null
      ? yield* requireAgent(call.env.roots, launch.agentName, run)
      : { name: launch.agentName, source: AGENT_SOURCE.INLINE };
  const unusable = yield* rejectUnusableWorkingDirectory(
    call.env.roots,
    launch.workingDirectory ?? undefined,
  );
  if (unusable) return unusable;
  const schema = launch.task === null ? launch.schema : null;
  const outputSchema =
    schema == null
      ? undefined
      : yield* Effect.try({
          try: () => normalizeStructuredOutputSchema(schema).jsonSchema,
          catch: (error) =>
            new ToolError(
              `\`schema\` is not a supported object-root JSON Schema: ${toErrorMessage(error)}`,
            ),
        });
  // The call's files: a run-storage file must be this run's own or a declared
  // output of a completed child of it; a trusted script's files pass as named.
  const trusted = isTrustedScript(run.config);
  const resolved = yield* Effect.result(
    Effect.all(
      (
        [
          ['Input file', files.inputFiles],
          ['Context file', files.contextFiles],
          ['Media file', files.mediaFiles],
        ] as const
      ).map(([label, list]) =>
        trusted
          ? Effect.succeed(list.map((file) => ({ file, absolutePath: file })))
          : resolveInvocationFileList(parentRunId, label, list),
      ),
      { concurrency: 'unbounded' },
    ),
  );
  if (Result.isFailure(resolved))
    return errorResult(toErrorMessage(resolved.failure));
  const [inputs = [], contexts = [], media = []] = resolved.success;
  const contextFiles = contexts.map(({ file }) => file);

  // Awaited in a script unless sent to the background, and always in a
  // one-shot run, which has no later turn for a follow-up to reach.
  const oneShot = noLaterTurn(run);
  const awaited =
    oneShot || (script !== undefined && launch.background !== true);
  // A task, a structured call and a trusted script's call reach the child
  // verbatim; any other is handed off with the parent's instruction.
  const handsOff = task === null && outputSchema === undefined && !trusted;
  // A completed call with the same prompt, options and file bytes is reused.
  // The requested model, not the one availability resolves to, so a reuse
  // does not depend on which credentials are configured now.
  const key =
    awaited && script !== undefined
      ? sha256({
          tool: launch.tool,
          prompt: launch.prompt,
          ...(handsOff && { handoff: call.instruction ?? null }),
          agent: agent.name,
          ...(persona != null && { persona }),
          model: launch.model ?? null,
          schema: outputSchema ?? null,
          ...files,
          options: task?.options ?? null,
          memories: launch.memories,
          workingDirectory: launch.workingDirectory ?? null,
          id: launch.id ?? null,
          files: yield* fingerprint(
            [inputs, contexts, media].map((group) =>
              group.map(({ absolutePath }) => absolutePath),
            ),
          ),
        })
      : undefined;
  if (key !== undefined && script !== undefined) {
    const reused = yield* reusable(call, script, key);
    if (reused !== null) return reused;
  }

  // An awaited child's progress is what this call prints while it runs:
  // transient text on its card, never a row of the run. The child's own run
  // (and, in a script, its stage row) is where its progress is kept.
  const notify = (update: SubagentProgressUpdate): void => {
    const line = describeSubagentProgress(agent.name, update);
    if (line) call.emit(`${line}\n`);
  };
  const timeoutMs = launch.timeoutMs ?? undefined;
  const running = <A, R>(
    work: Effect.Effect<A, Error, R>,
  ): Effect.Effect<A, Error, R> =>
    timeoutMs === undefined
      ? work
      : Effect.timeoutOrElse(work, {
          duration: timeoutMs,
          orElse: () => Effect.fail(new AgentTimedOut({ timeoutMs })),
        });

  // The child an earlier attempt of this call launched answers it, before
  // anything about a launch is decided again: it was approved and
  // configured when it launched.
  if (!awaited) {
    const earlier = yield* earlierChild(call);
    if (earlier !== null)
      return {
        ...executed(
          `Subagent '${agent.name}' was launched by an earlier attempt of this call; its result arrives as a follow-up.\nRun ID: ${earlier}`,
          `Launched '${agent.name}' (async)`,
        ),
        value: { runId: earlier },
      };
  } else {
    const recovered = yield* Effect.result(
      recoverAgentChild(call, { notify, running }),
    );
    if (Result.isFailure(recovered))
      return failedResult(agent.name, recovered.failure);
    const settled = recovered.success;
    if (settled.kind === 'ended')
      return yield* childResult(call, agent.name, settled, key);
  }

  // An unavailable model fails this call, which a script may catch.
  const selected = yield* Effect.result(
    selectAvailableDelegationModel({
      requestedModel: launch.model,
      parentModel: (yield* ScopedRef.get(run.model)).modelId,
      settings: call.env.roots,
    }),
  );
  if (Result.isFailure(selected))
    return errorResult(toErrorMessage(selected.failure), {
      name: 'ModelUnavailable',
    });
  const workingDirectory = launch.workingDirectory ?? call.env.workingDirectory;
  const proposal: AgentProposal = Schema.decodeUnknownSync(AgentProposalSchema)(
    {
      agent: agent.name,
      agentSource: agent.source,
      ...(persona != null && { persona }),
      model: selected.success,
      memories: launch.memories,
      ...(workingDirectory !== undefined && { workingDirectory }),
      task: task !== null,
      instruction: handsOff
        ? withToolUseSubagentHandoffInstruction(launch.prompt, call.instruction)
        : launch.prompt,
      inputFiles: inputs.map(({ file }) => file),
      contextFiles,
      mediaFiles: media.map(({ file }) => file),
      outputFiles: files.outputFiles,
      // A task's options reach the child through its plugin's recipe.
      ...(task !== null && { options: task.options }),
      ...(task === null && { rootUserInstruction: call.instruction }),
    },
  );

  const decided = yield* decideDelegation(
    call,
    proposal,
    script === undefined
      ? undefined
      : script.shared(AgentRequest, scriptRequest(call, script, proposal)),
  );
  if ('status' in decided) return decided;
  if (script !== undefined) {
    const limited = yield* countLaunch(script, agent.name);
    if (limited !== null) return limited;
  }

  // The asking script's `script`; the child's (with `options`) is set below.
  const { task: _t, script: _s, options: _o, ...approved } = decided.proposal;
  // An approval may pick another agent: a task's recipe is that agent's.
  const taskConfig = task?.configFor(decided.proposal);
  if (taskConfig === null)
    return errorResult(`'${approved.agent}' has no task block.`);
  const childApproval = decided.approvalMeta.childApproval ?? 'inherit';
  const grants = delegatedChildGrants(childApproval);
  const configPayload = {
    ...approved,
    // An approval that picked a catalog agent drops the one defined here.
    persona:
      approved.agentSource === AGENT_SOURCE.INLINE ? approved.persona : null,
    ...(outputSchema !== undefined && { outputSchema }),
    delegationAgentScope: run.config.delegationAgentScope,
    ...taskConfig,
  };
  if (!awaited) {
    const runId = agentChildRunId(call);
    const receipt = yield* launchDetachedSubagent(call, configPayload, {
      runId,
      grants,
      approvalMeta: decided.approvalMeta,
    });
    // What a script's `await` gets for a child sent to the background.
    return { ...receipt, value: { runId } };
  }
  const launched = yield* Effect.result(
    running(
      executeSubagentInBand({
        runId: agentChildRunId(call),
        parentRunId,
        configPayload,
        parentCall: { callId: call.callId, card: call.logId },
        grants,
        notify,
      }),
    ),
  );
  return Result.isFailure(launched)
    ? failedResult(approved.agent, launched.failure)
    : yield* childResult(call, approved.agent, launched.success, key);
});

/** The `agent` tool. */
export const agentTool = (): DefinedTool<AgentInput, PluginToolServices> =>
  defineTool({
    name: 'agent',
    requiresApproval: 'inBody',
    // A resumed call finds the child its earlier attempt launched and settles
    // from it, or resumes it under its own id: it never launches a second one.
    replay: 'safe',
    // A script's calls run beside each other, held to the child-run budget.
    lane: 'own',
    scriptGlobal: { positional: 'prompt' },
    // A script awaits the child's envelope, or `{ runId }` in the background.
    scriptReturns:
      "{ response: string; files: string[]; structured?: unknown; runId: string; outcome: 'completed'; cost: number; spent: number } | { runId: string }",
    slow: true,
    description: `Run a named agent as a child of this run: it works with its own tools on the prompt you give it.

From a script, \`agent(prompt, opts)\` (the same as \`tools.agent({ prompt, ...opts })\`) waits for the child and resolves to its result: \`{ response, files, structured?, runId, outcome, cost, spent }\`: \`cost\` is what the child and its own children spent, \`spent\` what this run has spent in all so far. It rejects with an Error named \`AgentFailed\`, \`TimedOut\`, or \`Skipped\` (the user stopped the child). With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up. A completed call is reused, not run again, by a later call in this run with the same prompt, options and file contents; give two otherwise identical calls of one script distinct \`id\`s.

Called directly, the child runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.

It returns the agent's final reply, or a \`schema\` value. Pick the agent whose description fits the task.`,
    schema: AgentInputSchema,
    execute: (input: AgentInput) =>
      launchChildAgent({
        tool: 'agent',
        agentName: input.agentName,
        persona: input.persona && {
          name: input.agentName,
          prompt: input.persona.prompt,
          tools: input.persona.tools ?? [],
        },
        prompt: input.prompt,
        model: input.model,
        schema: input.schema,
        memories: input.memories,
        workingDirectory: input.working_directory,
        id: input.id,
        timeoutMs: input.timeoutMs,
        background: input.background,
        mediaFiles: input.mediaFiles,
        task: null,
      }),
  });
