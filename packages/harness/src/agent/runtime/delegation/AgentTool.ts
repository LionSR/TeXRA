/**
 * The `agent` tool: run a child of the calling run on a prompt, with the
 * system text and tools the call gives it (or an installed plugin's agent,
 * by name). `launchChildAgent` is the launch it shares
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
import { capReached } from '@agent/runtime/spendCap';
import { ToolRegistry } from '@tools/toolTable';
import { getRunRecords } from '@agent/storage/runOwnership';
import { inRunSession, noLaterTurn } from '@agent/runtime/RunCall';
import { decisionOf } from '@agent/runtime/requests';
import type { RunToolCall, ScriptScope } from '@agent/runtime/RunCall';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import {
  runEndErrorMessage,
  AgentConfigSchema,
  type AgentConfig,
  AgentProposalSchema,
  type AgentProposal,
  toJsonValue,
  type RunEnd,
  type RunId,
  type ToolResult,
  programOf,
  programOrigin,
  type ProgramOrigin,
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
  countLaunch,
  earlierChild,
  fingerprint,
  limitResult,
  recoverAgentChild,
  reusable,
  treeCostOf,
  withinTime,
} from './agentChild';
import { selectAvailableDelegationModel } from './delegationAvailability';
import { executeSubagentInBand } from './childLaunch';
import {
  CALL_FIELDS,
  fileList,
  rejectUnusableWorkingDirectory,
  resolveInvocationFileList,
  withToolUseSubagentHandoffInstruction,
} from './inputFields';
import { pluginAgent } from './pluginAgents';
import { AgentRequest, decideDelegation } from './proposalFlow';
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
  system: optionalInput(
    Schema.NonEmptyString,
    'The child’s system text: who it is and how it works, written for this job. Required unless `agentName` is given.',
  ),
  tools: optionalInput(
    Schema.Array(Schema.NonEmptyString),
    'The tools the child gets, by name (`mcp__<server>__*` for every tool of a server). Omitted, none: it answers in text only.',
  ),
  agentName: optionalInput(
    Schema.NonEmptyString,
    'An installed plugin’s agent, `<plugin>:<name>` as the delegation targets list it: it runs with its own system text and tools, so give no `system` or `tools`.',
  ),
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

/**
 * One child launch as the shared core runs it: its prompt and what the
 * child is. A chat (`program: null`) is told `system` and given `tools`,
 * or is the installed plugin's agent `agentName`; it may ask for a value of
 * `schema` and attaches `mediaFiles` to its prompt. A
 * program's child is a run named for the registered program `name`, works
 * over `files` and is called with `args`, which its proposal shows as its
 * options.
 */
type ChildLaunch = {
  readonly prompt: string;
  readonly model: string | null | undefined;
  readonly workingDirectory: string | null | undefined;
  readonly id: string | null | undefined;
  readonly background: boolean | null | undefined;
  /** How long an awaited call waits for the child (`withinTime`). */
  readonly timeoutMs?: number | null | undefined;
  /** The child's spend cap, recorded on its run (`run.start.maxCostUsd`). */
  readonly maxCostUsd?: number | null | undefined;
} & (
  | {
      readonly program: null;
      readonly system: string | null | undefined;
      readonly tools: readonly string[] | null | undefined;
      readonly agentName: string | null | undefined;
      readonly label: string | null | undefined;
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
  if (result.outcome === 'cancelled') {
    const capped = capReached(
      yield* (yield* SessionViewAccess).read([]),
      runId,
      (yield* (yield* SessionLog).facts(runId))?.stop?.reason,
    );
    if (capped !== null)
      return errorResult(`'${agentName}' ${capped}`, {
        name: 'BudgetExceeded',
        summary: `'${agentName}' reached its cap`,
      });
    return errorResult(
      `The agent run ${runId} for '${agentName}' was stopped, so this call was skipped.`,
      {
        name: 'Skipped',
        summary: `Skipped '${agentName}'`,
      },
    );
  }
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
      programLaunch(program.name, program.args, launch.files, call.env.roots),
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
  // what the call wrote, or an installed plugin's agent read now, so the
  // child's config holds its system text and tools and a resume reads no
  // file.
  let agent: {
    name: string;
    system: string;
    tools: readonly string[];
    toolScope?: AgentConfig['toolScope'];
  };
  if (launch.program !== null)
    agent = { name: launch.program.name, system: '', tools: [] };
  else if (launch.agentName != null) {
    if (launch.system != null || launch.tools != null)
      return errorResult(
        '`agentName` runs an installed plugin’s agent with its own system text and tools: drop `system` and `tools`, or drop `agentName`.',
      );
    const named = yield* Effect.result(
      pluginAgent(launch.agentName, call.env.roots),
    );
    if (Result.isFailure(named)) return errorResult(named.failure.message);
    agent = named.success;
  } else if (launch.system == null)
    return errorResult(
      'Give the child a `system` text (and the `tools` it needs), or name an installed plugin’s agent with `agentName`.',
    );
  else
    agent = {
      name: launch.label?.trim() || 'agent',
      system: launch.system,
      tools: launch.tools ?? [],
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
  // completed child of it; a listed program's files pass as named, those
  // of a program read from a file are resolved like a model's.
  const caller = programOf(run.config);
  const verbatim =
    caller !== null &&
    (
      { listed: true, installed: false, own: false } satisfies Record<
        ProgramOrigin,
        boolean
      >
    )[programOrigin(caller.name)];
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
        verbatim
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
  // A time limit is how long a call waits: a background child has no such
  // call, and a limit nothing enforces is rejected. Its spend cap is the
  // run's own and holds either way.
  if (!awaited && launch.timeoutMs != null)
    return errorResult(
      '`timeoutMs` limits how long a call waits for its child, and this call runs in the background. Call it from a script without `background: true`, or drop the limit; `maxCostUsd` holds for a background child too.',
    );
  // A program's launch, a structured call and a call from a listed program
  // reach the child verbatim; any other is handed off with the parent's
  // instruction.
  const handsOff = program === null && outputSchema === undefined && !verbatim;
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
          system: agent.system,
          tools: agent.tools,
          model: launch.model ?? null,
          schema: outputSchema ?? null,
          ...files,
          program,
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
      recoverAgentChild(call, { notify, timeoutMs: launch.timeoutMs }),
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
      label: agent.name,
      system: agent.system,
      tools: agent.tools,
      model,
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
  // A program read from a file can be gone since the check above (its
  // plugin disabled or its file changed while the approval waited).
  const relaunched =
    program === null
      ? null
      : yield* Effect.result(
          programLaunch(program.name, program.args, approved, call.env.roots),
        );
  if (relaunched !== null && Result.isFailure(relaunched))
    return errorResult(relaunched.failure.message);
  const programConfig = relaunched?.success ?? null;
  const grants = delegatedChildGrants(decided.approvalMeta.childApproval);
  const config = Schema.decodeUnknownSync(AgentConfigSchema)({
    ...approved,
    ...(outputSchema !== undefined && { outputSchema }),
    // What an installed plugin's agent's tool list means, read with it.
    ...(agent.toolScope !== undefined && { toolScope: agent.toolScope }),
    ...programConfig,
  });
  const runId = agentChildRunId(call);
  if (!awaited) {
    const receipt = yield* launchDetachedSubagent(call, config, {
      runId,
      grants,
      maxCostUsd: launch.maxCostUsd,
      approvalMeta: decided.approvalMeta,
    });
    // What a script's `await` gets for a child sent to the background.
    return { ...receipt, value: { runId } };
  }
  const launched = yield* Effect.result(
    withinTime(
      launch.timeoutMs,
      executeSubagentInBand({
        runId,
        parentId,
        config,
        parentCall: { callId: call.callId, card: call.logId },
        grants,
        maxCostUsd: launch.maxCostUsd,
        notify,
      }),
    ),
  );
  return Result.isFailure(launched)
    ? failedResult(approved.label, launched.failure)
    : yield* childResult(call, approved.label, launched.success, key);
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
    description: `Run a child agent on a prompt. You write the child: \`system\` says who it is and how it works for this job, \`tools\` names the tools it gets (none: it answers in text only), \`label\` names it, and the prompt is its task. It sees none of your conversation.

From a script, \`agent(prompt, opts)\` (the same as \`tools.agent({ prompt, ...opts })\`) waits for the child and resolves to its result: \`{ response, files, structured?, runId, outcome, cost, spent }\`: \`cost\` is what the child and its own children spent, \`spent\` what this run has spent in all so far. It rejects with an Error named \`AgentFailed\`, \`TimedOut\` (past \`timeoutMs\`), \`BudgetExceeded\` (the child and the runs it started spent \`maxCostUsd\` before it finished; the cap is read after each reply, so the spend can pass it by the replies then in flight), \`Skipped\` (the user stopped the child), \`DuplicateCall\` (a second identical call in one script) or \`ModelUnavailable\`. With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up; a background child stopped at its \`maxCostUsd\` says so in that follow-up. A completed call is reused, not run again, by a later call in this run with the same prompt, options and file contents; give two otherwise identical calls of one script distinct \`id\`s.

Called directly, the child runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.

Its result is the child's final reply, or a \`schema\` value. \`agentName\` instead runs an agent an installed plugin provides, with its own system text and tools, when the delegation targets list one.`,
    schema: AgentInputSchema,
    execute: (input: AgentInput) =>
      launchChildAgent({
        system: input.system,
        tools: input.tools,
        agentName: input.agentName,
        label: input.label,
        prompt: input.prompt,
        model: input.model,
        schema: input.schema,
        workingDirectory: input.working_directory,
        id: input.id,
        timeoutMs: input.timeoutMs,
        maxCostUsd: input.maxCostUsd,
        background: input.background,
        mediaFiles: input.mediaFiles,
        program: null,
      }),
  });
