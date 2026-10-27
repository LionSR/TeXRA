/**
 * The `agent` tool: run a named agent as a child of the calling run, with
 * its prompt and its own tools. `launchChildAgent` is the launch it shares
 * with a plugin's task tools (`launchesTasks`), which launch the same child
 * opened on the plugin's recipe.
 *
 * Called from a script it awaits the child and returns the child's envelope
 * (`{ ...output, outcome, cost, spent }`), unless `background` detaches it; called
 * directly it detaches, as a delegation always has, except in a one-shot
 * run, which waits. The script's `agent` calls share one approval request
 * showing its source; a direct call proposes itself. A completed
 * awaited call is reused by a later call with the same key in the same run
 * or a background script run of it, and a call cut short finds the
 * child its attempt launched
 * (`agentChild.ts`).
 */

// Third-party imports
import { Cause, Effect, Exit, Result, Schema, SynchronizedRef } from 'effect';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ToolContext } from '@agent/core/tools/ToolTypes';
import type { JSONSchemaObject } from '@agent/core/tools/toolSchema';
import { isTrustedScript } from '@agent/core/definition/RunRecord';
import { scriptChildBudget } from '@agent/runtime/childRunBudget';
import { requireToolRun } from '@agent/runtime/RunCall';
import type { AgentRunServices } from '@agent/runtime/runRegistry';
import type { RunToolCall, ScriptScope } from '@agent/runtime/RunCall';
import {
  AGENT_SOURCE,
  AgentProposalSchema,
  type AgentProposal,
  type AgentSource,
  type ToolResult,
} from '@shared/schemas';
import { attemptRequests, callRequestId } from '@shared/session/inFlight';
import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';
import { defineTool, type DefinedTool } from '@tools/core/definition';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { errorResult, executed } from '@tools/core/result';
import { sha256 } from '@utils/core/idHash';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  agentChildRunId,
  childResult,
  countLaunch,
  earlierChild,
  fingerprint,
  recoverAgentChild,
  reusable,
} from './agentChild';
import { selectAvailableDelegationModel } from './delegationAvailability';
import {
  executeSubagentInBand,
  SubagentDurabilityError,
} from './inBandSubagentRun';
import {
  memoriesField,
  outputJsonSchemaOf,
  personaField,
  rejectUnusableWorkingDirectory,
  resolveCallFiles,
  type CallFiles,
  withToolUseSubagentHandoffInstruction,
  workingDirectoryField,
} from './inputFields';
import { decideDelegation, requireAgent } from './proposalFlow';
import {
  delegatedChildGrants,
  launchDetachedSubagent,
  subagentProgressSink,
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

/**
 * The fields every child launch takes beside its own: memories, the call's
 * reuse id and card label, its time limit, and whether a script waits.
 */
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
type AgentToolServices = AgentRunServices | ToolContext;

/**
 * One child launch as the shared core runs it: the agent and its prompt,
 * the files a task works over (empty for a chat), and the recipe a task's
 * run opens on. `tool` names the launching tool in its reuse key and its
 * copy.
 */
export interface ChildLaunch {
  readonly tool: string;
  readonly agentName: string;
  /** An agent the call defines, named `agentName`: no catalog entry. */
  readonly persona?: AgentProposal['persona'];
  readonly prompt: string;
  readonly model: string | null | undefined;
  readonly schema: Record<string, unknown> | null | undefined;
  readonly memories: readonly string[];
  readonly workingDirectory: string | null | undefined;
  readonly id: string | null | undefined;
  readonly timeoutMs: number | null | undefined;
  readonly background: boolean | null | undefined;
  readonly files: {
    readonly inputFiles: readonly string[];
    readonly contextFiles: readonly string[];
    readonly mediaFiles: readonly string[];
    readonly outputFiles: readonly string[];
  };
  /** A task: the child opens on what the launching plugin builds for the
   *  approved agent (its recipe and outputs; null for an agent with no task
   *  block); the proposal says it works over `files` with `options`. */
  readonly task: {
    readonly configFor: (
      chosen: AgentProposal,
    ) => Pick<AgentConfig, 'script' | 'outputFiles'> | null;
    readonly options: NonNullable<AgentProposal['options']>;
  } | null;
}

/**
 * The request the `agent` calls of one script share: the first to ask opens
 * it, and a resumed script finds it, answered or still open, from its rows.
 * It is the script call's, shared by all its attempts (attempt 0), so it
 * outlives a restart; one the run's stop cancelled is asked again under the
 * next ordinal.
 */
const scriptRequest = Effect.fn('AgentTool.scriptRequest')(function* (
  call: RunToolCall,
  script: ScriptScope,
  proposal: AgentProposal,
) {
  const { session, runId } = call.run;
  const shared = {
    responseId: call.responseId,
    callId: script.callId,
    attempt: 0,
  };
  const from = session.log.now();
  const state = yield* session.runHistory.load(runId);
  const { raised, own } = attemptRequests(state?.requests ?? {}, shared);
  if (own?.request.decision === null)
    // A plane that closes first decides nothing: the call stays in
    // flight, and the next resume finds the request still open.
    return yield* session.requests.decision(runId, own.requestId, from).pipe(
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
  return yield* call.requests.open({
    kind: 'proposal',
    data: {
      requestId: callRequestId(shared, raised + 1),
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
  });
});

/** One call: a script's awaited calls within {@link scriptChildBudget}. */
export const launchChildAgent = Effect.fn('AgentTool.call')(function* (
  launch: ChildLaunch,
) {
  const call = yield* requireToolRun(launch.tool);
  const { script } = call;
  if (script === null || launch.background === true)
    return yield* agentCall(call, launch);
  const budget = yield* scriptChildBudget(call.env.roots, script);
  return yield* budget.withPermits(1)(agentCall(call, launch));
});

/** A child's run failed the call: timed out, or ended without an answer. */
export function failedResult(agentName: string, error: Error): ToolResult {
  if (error instanceof AgentTimedOut)
    return errorResult(
      `'${agentName}' did not finish within ${error.timeoutMs} ms; its run was stopped.`,
      { name: 'TimedOut', summary: `'${agentName}' timed out` },
    );
  return errorResult(toErrorMessage(error), {
    // The child's own failure; a durability fault is the call's.
    ...(!(error instanceof SubagentDurabilityError) && { name: 'AgentFailed' }),
    summary: `'${agentName}' failed`,
  });
}

/** The agent a call runs: the one it defines, or one the run may launch. */
const agentOf = (call: RunToolCall, launch: ChildLaunch) =>
  launch.persona == null
    ? requireAgent(call.env.roots, launch.agentName, call.run)
    : Effect.succeed({ name: launch.agentName, source: AGENT_SOURCE.INLINE });

/** `work` held to the call's `timeoutMs`; past it the wait is interrupted,
 *  which stops the child. */
const limitedBy =
  (timeoutMs: number | null | undefined) =>
  <A, R>(work: Effect.Effect<A, Error, R>): Effect.Effect<A, Error, R> =>
    timeoutMs == null
      ? work
      : work.pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(new AgentTimedOut({ timeoutMs })),
          }),
        );

/**
 * An awaited script call's reuse key, and the completed call with that key it
 * reuses, if any: the same prompt, options and file bytes. The requested
 * model, not the one availability resolves to, so a reuse does not depend on
 * which credentials are configured now.
 */
const reuseOf = Effect.fn('AgentTool.reuseOf')(function* (
  call: RunToolCall,
  script: ScriptScope,
  launch: ChildLaunch,
  agent: string,
  outputSchema: JSONSchemaObject | undefined,
  handsOff: boolean,
  groups: CallFiles,
) {
  const { persona, files, task } = launch;
  const key = sha256({
    tool: launch.tool,
    prompt: launch.prompt,
    ...(handsOff && { handoff: call.instruction ?? null }),
    agent,
    ...(persona != null && { persona }),
    model: launch.model ?? null,
    schema: outputSchema ?? null,
    ...files,
    options: task?.options ?? null,
    memories: launch.memories,
    workingDirectory: launch.workingDirectory ?? null,
    id: launch.id ?? null,
    files: yield* fingerprint(
      groups.map((group) => group.map(({ absolutePath }) => absolutePath)),
    ),
  });
  return { key, reused: yield* reusable(call, script, key) };
});

/**
 * What the child an earlier attempt of this call launched answers it with,
 * before anything about a launch is decided again (it was approved and
 * configured when it launched); null when this attempt launches its own.
 */
const earlierAnswer = Effect.fn('AgentTool.earlierAnswer')(function* (
  call: RunToolCall,
  launch: ChildLaunch,
  agent: string,
  awaited: boolean,
  key: string | undefined,
) {
  if (!awaited) {
    const earlier = yield* earlierChild(call);
    if (earlier === null) return null;
    return {
      ...executed(
        `Subagent '${agent}' was launched by an earlier attempt of this call; its result arrives as a follow-up.\nRun ID: ${earlier}`,
        `Launched '${agent}' (async)`,
      ),
      value: { runId: earlier },
    };
  }
  const recovered = yield* Effect.result(
    recoverAgentChild(call, {
      notify: subagentProgressSink(call, agent),
      running: limitedBy(launch.timeoutMs),
    }),
  );
  if (Result.isFailure(recovered))
    return failedResult(agent, recovered.failure);
  const settled = recovered.success;
  return settled.kind === 'ended'
    ? yield* childResult(call, agent, settled, key)
    : null;
});

/** The delegation a call proposes, on the model availability selects for it;
 *  an unavailable model fails the call, which a script may catch. */
const proposalOf = Effect.fn('AgentTool.proposalOf')(function* (
  call: RunToolCall,
  launch: ChildLaunch,
  agent: { readonly name: string; readonly source: AgentSource },
  handsOff: boolean,
  [inputs, contexts, media]: CallFiles,
) {
  const { persona, task } = launch;
  const selected = yield* Effect.exit(
    selectAvailableDelegationModel({
      requestedModel: launch.model,
      parentModel: (yield* SynchronizedRef.get(call.run.model)).modelId,
      settings: call.env.roots,
    }),
  );
  if (Exit.isFailure(selected))
    return errorResult(toErrorMessage(Cause.squash(selected.cause)), {
      name: 'ModelUnavailable',
    });
  const workingDirectory = launch.workingDirectory ?? call.env.workingDirectory;
  const proposal: AgentProposal = Schema.decodeUnknownSync(AgentProposalSchema)(
    {
      agent: agent.name,
      agentSource: agent.source,
      ...(persona != null && { persona }),
      model: selected.value,
      memories: launch.memories,
      ...(workingDirectory !== undefined && { workingDirectory }),
      task: task !== null,
      instruction: handsOff
        ? withToolUseSubagentHandoffInstruction(launch.prompt, call.instruction)
        : launch.prompt,
      inputFiles: inputs.map(({ file }) => file),
      contextFiles: contexts.map(({ file }) => file),
      mediaFiles: media.map(({ file }) => file),
      outputFiles: launch.files.outputFiles,
      // A task's options reach the child through its plugin's recipe.
      ...(task !== null && { options: task.options }),
      ...(task === null && { rootUserInstruction: call.instruction }),
    },
  );
  return proposal;
});

/** Put `proposal` to approval and launch the child it settles on: detached
 *  with a receipt, or awaited to its envelope. */
const decideAndLaunch = Effect.fn('AgentTool.decideAndLaunch')(function* (
  call: RunToolCall,
  launch: ChildLaunch,
  proposal: AgentProposal,
  outputSchema: JSONSchemaObject | undefined,
  awaited: boolean,
  key: string | undefined,
) {
  const { run } = call;
  const script = call.script ?? undefined;
  const decided = yield* decideDelegation(
    call,
    proposal,
    script === undefined
      ? undefined
      : script.shared('agent:request', scriptRequest(call, script, proposal)),
  );
  if ('status' in decided) return decided;
  if (script !== undefined) {
    const limited = yield* countLaunch(script, proposal.agent);
    if (limited !== null) return limited;
  }

  // The asking script's `script`; the child's (with `options`) is set below.
  const { task: _t, script: _s, options: _o, ...approved } = decided.proposal;
  // An approval may pick another agent: a task's recipe is that agent's.
  const taskConfig = launch.task?.configFor(decided.proposal);
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
    delegationAgentScope: run.delegationAgentScope,
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
    return receipt.status === 'executed'
      ? { ...receipt, value: { runId } }
      : receipt;
  }
  const launched = yield* Effect.result(
    limitedBy(launch.timeoutMs)(
      executeSubagentInBand({
        session: run.session,
        runId: agentChildRunId(call),
        parentRunId: run.runId,
        configPayload,
        parentCard: call.logId,
        parentCallId: call.callId,
        grants,
        notify: subagentProgressSink(call, proposal.agent),
      }),
    ),
  );
  return Result.isFailure(launched)
    ? failedResult(approved.agent, launched.failure)
    : yield* childResult(call, approved.agent, launched.success, key);
});

const agentCall = Effect.fn('AgentTool.agentCall')(function* (
  call: RunToolCall,
  launch: ChildLaunch,
) {
  const { run } = call;
  const script = call.script ?? undefined;
  const agent = yield* agentOf(call, launch);
  const unusable = yield* rejectUnusableWorkingDirectory(
    call.env.roots,
    launch.workingDirectory ?? undefined,
  );
  if (unusable) return unusable;
  const outputSchema = yield* outputJsonSchemaOf(launch.schema);
  const trusted = isTrustedScript(run.config);
  const resolved = yield* Effect.exit(
    resolveCallFiles(run.session, run.runId, launch.files, trusted),
  );
  if (Exit.isFailure(resolved))
    return errorResult(toErrorMessage(Cause.squash(resolved.cause)));
  const groups = resolved.value;

  // Awaited in a script unless sent to the background, and always in a
  // one-shot run, which has no later turn for a follow-up to reach.
  const awaited =
    run.toolPolicy.stopAfterCycle === true ||
    (script !== undefined && launch.background !== true);
  // A task, a structured call and a trusted script's call reach the child
  // verbatim; any other is handed off with the parent's instruction.
  const handsOff =
    launch.task === null && outputSchema === undefined && !trusted;
  const { key, reused } =
    awaited && script !== undefined
      ? yield* reuseOf(
          call,
          script,
          launch,
          agent.name,
          outputSchema,
          handsOff,
          groups,
        )
      : { key: undefined, reused: null };
  if (reused !== null) return reused;

  const earlier = yield* earlierAnswer(call, launch, agent.name, awaited, key);
  if (earlier !== null) return earlier;
  const proposal = yield* proposalOf(call, launch, agent, handsOff, groups);
  if ('status' in proposal) return proposal;
  return yield* decideAndLaunch(
    call,
    launch,
    proposal,
    outputSchema,
    awaited,
    key,
  );
});

/** The `agent` tool. */
export const agentTool = (): DefinedTool<AgentInput, AgentToolServices> =>
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
        files: {
          inputFiles: [],
          contextFiles: [],
          mediaFiles: input.mediaFiles,
          outputFiles: [],
        },
        task: null,
      }),
  });
