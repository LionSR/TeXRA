/**
 * The `agent` tool: run a named agent as a child of the calling run, with
 * its prompt and its own tools. `launchChildAgent` is the launch it shares
 * with the `program` tool (`./ProgramTool`), which opens the same child on
 * a registered program. A script's `agent` calls share one approval request
 * showing its source; a direct call proposes itself. A completed awaited
 * call is reused by a later call with the same key in the same run or a
 * background script run of it, and a call cut short finds the child its
 * attempt launched (`agentChild.ts`). When a call waits and what it returns
 * is in the tool's description.
 */

// Third-party imports
import { Effect, Result, Schema, ScopedRef } from 'effect';

// Local imports
import { programLaunch, readProgramResult } from '@agent/runtime/programRun';
import { ToolRegistry } from '@tools/toolTable';
import { getRunRecords } from '@agent/storage/runOwnership';
import { inRunSession, noLaterTurn } from '@agent/runtime/RunCall';
import { decisionOf } from '@agent/runtime/requests';
import type { RunToolCall, ScriptScope } from '@agent/runtime/RunCall';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import {
  runEndErrorMessage,
  AGENT_SOURCE,
  AgentConfigSchema,
  AgentProposalSchema,
  type AgentProposal,
  toJsonValue,
  type RunEnd,
  type RunId,
  type ToolResult,
  isInstalledProgram,
  programOf,
  AGENT_TOOL_NAME,
} from '@shared/schemas';
import { attemptRequests, callRequestId } from '@shared/session/inFlight';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';
import { defineTool, type DefinedTool } from '@tools/core/definition';
import { optionalInput } from '@tools/core/inputSchema';
import { errorResult, executed } from '@tools/core/result';
import { sha256 } from '@utils/core/idHash';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  agentChildRunId,
  type ChildLimits,
  countLaunch,
  earlierChild,
  fingerprint,
  limitResult,
  recoverAgentChild,
  reusable,
  treeCostOf,
  withinLimits,
} from './agentChild';
import { selectAvailableDelegationModel } from './delegationAvailability';
import { executeSubagentInBand } from './childLaunch';
import {
  CALL_FIELDS,
  fileList,
  personaField,
  rejectUnusableWorkingDirectory,
  resolveInvocationFileList,
  withToolUseSubagentHandoffInstruction,
} from './inputFields';
import { AgentRequest, decideDelegation, requireAgent } from './proposalFlow';
import {
  delegatedChildGrants,
  childOutputSchema,
  printSubagentProgress,
  launchDetachedSubagent,
} from './subagentRun';

/** The fields that name what an `agent` call runs. */
const LAUNCH_FIELDS = {
  prompt: Schema.NonEmptyString.annotate({
    description:
      'The task, in plain prose. Name the files it concerns and copy every constraint the agent must follow: it does not see your conversation.',
  }),
  agentName: Schema.NonEmptyString.annotate({
    description: 'The agent to run. It works with its own tools.',
  }),
  persona: personaField,
  schema: optionalInput(
    Schema.Record(Schema.String, Schema.Unknown),
    'A JSON Schema object: the agent finishes by submitting a value of it, returned as `structured`.',
  ),
  mediaFiles: fileList(
    'Images, figures, PDFs or audio attached to the prompt.',
  ),
};

const AgentInputSchema = Schema.Struct({ ...LAUNCH_FIELDS, ...CALL_FIELDS });
type AgentInput = typeof AgentInputSchema.Type;

/** An agent a launch carries instead of naming a catalog entry. */
type InlineAgent = Extract<
  NonNullable<AgentProposal['agentSource']>,
  { kind: 'inline' }
>;

/**
 * One child launch as the shared core runs it: its prompt and what the
 * child is. A chat (`program: null`) runs the agent `agentName`, may ask
 * for a value of `schema` and attaches `mediaFiles` to its prompt. A
 * program's child is a run named for the registered program `name`, works
 * over `files` and is called with `args`, which its proposal shows as its
 * options.
 */
type ChildLaunch = {
  readonly prompt: string;
  readonly model: string | null | undefined;
  readonly memories: readonly string[];
  readonly workingDirectory: string | null | undefined;
  readonly id: string | null | undefined;
  readonly background: boolean | null | undefined;
} & ChildLimits &
  (
    | {
        readonly program: null;
        readonly agentName: string;
        /** An agent the call defines, named `agentName`: no catalog entry. */
        readonly persona?: InlineAgent['persona'] | null;
        readonly schema: Record<string, unknown> | null | undefined;
        readonly mediaFiles: readonly string[];
      }
    | {
        readonly program: {
          readonly name: string;
          readonly args: Readonly<Record<string, Schema.Json>>;
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
 * (attempt 0), read from the run's rows: the script's calls wait together
 * on the one that is open (`decisionOf`) and take the answer a person gave
 * it, one given while no process held the run included (the resume's
 * activation commits it); a stop or a resume cancels an open one, and the
 * next request takes the next ordinal through the call's requests.
 */
const scriptRequest = Effect.fn('AgentTool.scriptRequest')(function* (
  call: RunToolCall,
  script: ScriptScope,
  proposal: AgentProposal,
) {
  const { runId } = call.run;
  const shared = {
    responseId: call.responseId,
    callId: script.callId,
    attempt: 0,
  };
  const log = yield* SessionLog;
  const from = log.now();
  // The run's request rows alone, as a decision reads them.
  const { requests } = yield* log.runRows(runId, 'requests');
  const { raised, last } = attemptRequests(requests, shared);
  if (last !== null) {
    const { decision } = last.request;
    if (decision === null)
      return yield* decisionOf(runId, last.requestId, from);
    if (decision.action !== 'cancel') return decision;
  }
  const calls = yield* script.calls;
  return yield* call.requests
    .open({
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
    })
    .pipe(Effect.map(({ decision }) => decision));
});

/** What an ended child becomes for its call: the report its end stored,
 *  the envelope its parent's model reads (a program's read through its
 *  registered result), or the error a script's `await` throws for it. */
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
      `The agent run ${runId} for '${agentName}' ended ${result.outcome}${result.error ? `: ${runEndErrorMessage(result.error)}` : '.'}`,
      { name: 'AgentFailed', summary: `'${agentName}' failed` },
    );
  const records = getRunRecords(runId);
  // A child's end commits its report with its `run.end`: a completed child
  // with none is a defect.
  const report = yield* records.readReport();
  if (report === null)
    return yield* Effect.die(
      new Error(`The agent run ${runId} completed without a report.`),
    );
  const config = yield* records.readConfig();
  const view = yield* (yield* SessionViewAccess).read([]);
  const program = yield* readProgramResult(config, runId, call.env.roots);
  return {
    ...executed(report, `Completed '${agentName}'`),
    value: toJsonValue({
      ...result.output,
      ...(program !== undefined && { changes: program.changes }),
      runId,
      outcome: result.outcome,
      cost: treeCostOf(view, runId),
      spent: treeCostOf(view, call.run.runId),
    }),
    ...(key !== undefined && { reuseKey: key }),
  };
});

/** One call, launched over its call's session. */
export const launchChildAgent = (launch: ChildLaunch) =>
  inRunSession((call) => agentCall(call, launch)).pipe(
    Effect.withSpan('AgentTool.call'),
  );

/** A child's run failed the call: past a limit of the call, or ended
 *  without an answer. */
export function failedResult(agentName: string, error: Error): ToolResult {
  return (
    limitResult(agentName, error) ??
    errorResult(toErrorMessage(error), {
      name: 'AgentFailed',
      summary: `'${agentName}' failed`,
    })
  );
}

/**
 * The model a child of `call` runs on: the one its call names, else the
 * calling run's, else the first available, checked against the models that
 * can run now. A model the call names that cannot is the call's error,
 * which a script may catch.
 */
export const childModel = Effect.fn('AgentTool.childModel')(function* (
  call: RunToolCall,
  requested: string | null | undefined,
) {
  const { run } = call;
  const selected = yield* Effect.result(
    selectAvailableDelegationModel({
      requestedModel: requested,
      parentModel: (yield* ScopedRef.get(run.model)).modelId,
      settings: call.env.roots,
    }),
  );
  if (Result.isFailure(selected))
    return errorResult(toErrorMessage(selected.failure), {
      name: 'ModelUnavailable',
    });
  if (selected.success._tag === 'Fallback')
    run.logger.warn(selected.success.notice);
  return selected.success.model;
});

const agentCall = Effect.fn('AgentTool.agentCall')(function* (
  call: RunToolCall,
  launch: ChildLaunch,
) {
  const { run } = call;
  const script = call.script ?? undefined;
  const { runId: parentId } = run;
  const { program } = launch;
  // A name no plugin registers fails before anyone is asked to approve it.
  if (program !== null) {
    const known = yield* Effect.result(
      programLaunch(program.name, program.args, launch.files),
    );
    if (Result.isFailure(known)) return errorResult(known.failure.message);
  }
  // A chat's files are the media on its prompt; a program names its four
  // lists.
  const files =
    launch.program === null
      ? {
          inputFiles: [],
          contextFiles: [],
          mediaFiles: launch.mediaFiles,
          outputFiles: [],
        }
      : launch.files;
  // A program's child is the program's own run, named for it; a chat's is
  // the agent the call defines, or the catalog's.
  const agent: {
    name: string;
    source: NonNullable<AgentProposal['agentSource']>;
  } =
    launch.program !== null
      ? {
          name: launch.program.name,
          source: { kind: AGENT_SOURCE.INLINE, persona: {} },
        }
      : launch.persona == null
        ? yield* Effect.map(
            requireAgent(call.env.roots, launch.agentName, run),
            (entry) => ({ name: entry.name, source: { kind: entry.source } }),
          )
        : {
            name: launch.agentName,
            source: { kind: AGENT_SOURCE.INLINE, persona: launch.persona },
          };
  const unusable = yield* rejectUnusableWorkingDirectory(
    call.env.roots,
    launch.workingDirectory ?? undefined,
  );
  if (unusable) return unusable;
  const outputSchema = yield* childOutputSchema(
    launch.program === null ? launch.schema : null,
  );
  // The call's files, the program's file arguments among them: a
  // run-storage file must be this run's own or a declared output of a
  // completed child of it; a registered program's files pass as named, an
  // installed plugin's program's are resolved like a model's.
  const caller = programOf(run.config);
  const trusted = caller !== null && !isInstalledProgram(caller.name);
  const fileArgs =
    program === null
      ? []
      : ((yield* ToolRegistry).programs.get(program.name)?.fileArgs ?? []);
  const resolved = yield* Effect.result(
    Effect.all(
      [
        ['Input file', files.inputFiles] as const,
        ['Context file', files.contextFiles] as const,
        ['Media file', files.mediaFiles] as const,
        ...fileArgs.flatMap((key) => {
          const value = program?.args[key];
          return typeof value === 'string'
            ? [[`Argument ${key}`, [value]] as const]
            : [];
        }),
      ].map(([label, list]) =>
        trusted
          ? Effect.succeed(list.map((file) => ({ file, absolutePath: file })))
          : resolveInvocationFileList(parentId, label, list),
      ),
      { concurrency: 'unbounded' },
    ),
  );
  if (Result.isFailure(resolved))
    return errorResult(toErrorMessage(resolved.failure));
  const [inputs = [], contexts = [], media = [], ...fileArgFiles] =
    resolved.success;
  const contextFiles = contexts.map(({ file }) => file);

  // Awaited in a script unless sent to the background, and always in a
  // one-shot run, which has no later turn for a follow-up to reach.
  const oneShot = noLaterTurn(run);
  const awaited =
    oneShot || (script !== undefined && launch.background !== true);
  // Only the call that waits for a child holds it to a limit: a background
  // child has no such call, and a limit nothing enforces is rejected.
  if (!awaited && (launch.timeoutMs != null || launch.maxCostUsd != null))
    return errorResult(
      '`timeoutMs` and `maxCostUsd` limit a child its call waits for, and this call runs in the background. Call it from a script without `background: true`, or drop the limit.',
    );
  // A program's launch, a structured call and a call from a program reach
  // the child verbatim; any other is handed off with the parent's
  // instruction.
  const handsOff = program === null && outputSchema === undefined && !trusted;
  // A completed call with the same prompt, options and file bytes is reused.
  // The requested model, not the one availability resolves to, so a reuse
  // does not depend on which credentials are configured now. The call's
  // limits are no part of it: a completed result answers the call under
  // any of them, and reusing it spends nothing.
  const key =
    awaited && script !== undefined
      ? sha256({
          prompt: launch.prompt,
          ...(handsOff && { handoff: call.instruction ?? null }),
          agent: agent.name,
          ...(agent.source.kind === AGENT_SOURCE.INLINE && {
            persona: agent.source.persona,
          }),
          model: launch.model ?? null,
          schema: outputSchema ?? null,
          ...files,
          program,
          memories: launch.memories,
          workingDirectory: launch.workingDirectory ?? null,
          id: launch.id ?? null,
          files: yield* fingerprint(
            [inputs, contexts, media, ...fileArgFiles].map((group) =>
              group.map(({ absolutePath }) => absolutePath),
            ),
          ),
        })
      : undefined;
  if (key !== undefined && script !== undefined) {
    const reused = yield* reusable(call, script, key);
    if (reused !== null) return reused;
  }

  const notify = printSubagentProgress(agent.name, call.emit);

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
      recoverAgentChild(call, { notify, limits: launch }),
    );
    if (Result.isFailure(recovered))
      return failedResult(agent.name, recovered.failure);
    const settled = recovered.success;
    if (settled.kind === 'ended')
      return yield* childResult(call, agent.name, settled, key);
  }

  const model = yield* childModel(call, launch.model);
  if (typeof model !== 'string') return model;
  const workingDirectory = launch.workingDirectory ?? call.env.workingDirectory;
  const proposal: AgentProposal = Schema.decodeUnknownSync(AgentProposalSchema)(
    {
      agent: agent.name,
      agentSource: agent.source,
      model,
      memories: launch.memories,
      ...(workingDirectory !== undefined && { workingDirectory }),
      task: program !== null,
      instruction: handsOff
        ? withToolUseSubagentHandoffInstruction(launch.prompt, call.instruction)
        : launch.prompt,
      inputFiles: inputs.map(({ file }) => file),
      contextFiles,
      mediaFiles: media.map(({ file }) => file),
      outputFiles: files.outputFiles,
      // The arguments, shown as the proposal's options.
      ...(program !== null && { options: program.args }),
      ...(program === null && { rootUserInstruction: call.instruction }),
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

  // The asking script's `script`; the child's (with its arguments) is set
  // below; the options are the program's arguments, shown for approval.
  const { task: _t, script: _s, options: _o, ...approved } = decided.proposal;
  // A program's run is the program's own, whatever agent an approval named.
  // An installed plugin's program can be gone since the check above (its
  // plugin disabled or changed while the approval waited).
  const relaunched =
    program === null
      ? null
      : yield* Effect.result(
          programLaunch(program.name, program.args, approved),
        );
  if (relaunched !== null && Result.isFailure(relaunched))
    return errorResult(relaunched.failure.message);
  const programConfig = relaunched?.success ?? null;
  const grants = delegatedChildGrants(decided.approvalMeta.childApproval);
  const config = Schema.decodeUnknownSync(AgentConfigSchema)({
    ...approved,
    ...(outputSchema !== undefined && { outputSchema }),
    delegationAgentScope: run.config.delegationAgentScope,
    ...programConfig,
  });
  const runId = agentChildRunId(call);
  if (!awaited) {
    const receipt = yield* launchDetachedSubagent(call, config, {
      runId,
      grants,
      approvalMeta: decided.approvalMeta,
    });
    // What a script's `await` gets for a child sent to the background.
    return { ...receipt, value: { runId } };
  }
  const launched = yield* Effect.result(
    withinLimits(
      runId,
      launch,
      executeSubagentInBand({
        runId,
        parentId,
        config,
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

export const agentTool = (): DefinedTool<AgentInput, PluginToolServices> =>
  defineTool({
    name: AGENT_TOOL_NAME,
    requiresApproval: 'inBody',
    // A resumed call finds the child its earlier attempt launched and finishes
    // from it, or resumes it under its own id: it never launches a second one.
    replay: 'safe',
    // A script's calls run beside each other, held to the child-run budget.
    lane: 'own',
    scriptGlobal: { positional: 'prompt' },
    // A script awaits the child's envelope, or `{ runId }` in the background.
    scriptReturns:
      "{ response: string; files: string[]; structured?: unknown; runId: string; outcome: 'completed'; cost: number; spent: number } | { runId: string }",
    description: `Run a named agent as a child of this run: it works with its own tools on the prompt you give it.

From a script, \`agent(prompt, opts)\` (the same as \`tools.agent({ prompt, ...opts })\`) waits for the child and resolves to its result: \`{ response, files, structured?, runId, outcome, cost, spent }\`: \`cost\` is what the child and its own children spent, \`spent\` what this run has spent in all so far. It rejects with an Error named \`AgentFailed\`, \`TimedOut\` (past \`timeoutMs\`), \`BudgetExceeded\` (the child and the runs it started spent \`maxCostUsd\` before it finished; the cap is read after each reply, so the spend can pass it by the replies then in flight), \`Skipped\` (the user stopped the child), \`DuplicateCall\` (a second identical call in one script) or \`ModelUnavailable\`. With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up. A completed call is reused, not run again, by a later call in this run with the same prompt, options and file contents; give two otherwise identical calls of one script distinct \`id\`s.

Called directly, the child runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.

Its result is the agent's final reply, or a \`schema\` value. Pick the agent whose description fits the task.`,
    schema: AgentInputSchema,
    execute: (input: AgentInput) =>
      launchChildAgent({
        agentName: input.agentName,
        persona: input.persona && {
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
        maxCostUsd: input.maxCostUsd,
        background: input.background,
        mediaFiles: input.mediaFiles,
        program: null,
      }),
  });
