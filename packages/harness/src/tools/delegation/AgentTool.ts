/**
 * The `agent` tool: run a named agent as a child of the calling run, with
 * its prompt and its own tools. `launchChildAgent` is the launch it shares
 * with an app's task tools (TeXRA's `document_task`), which launch the same
 * child opened on a script.
 *
 * Called from a script it awaits the child and returns the child's envelope
 * (`{ ...output, outcome, cost }`), unless `background` detaches it; called
 * directly it detaches, as a delegation always has, except in a one-shot
 * run, which waits. The script's `agent` calls share one approval request
 * showing its source (Q5); a direct call proposes itself. A completed
 * awaited call is reused by a later call with the same key in the same run
 * or a background script run of it (Q2), and a call cut short finds the
 * child its attempt launched
 * (`agentChild.ts`).
 */

// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import {
  Cause,
  Data,
  Effect,
  Exit,
  FileSystem,
  Result,
  Semaphore,
  SynchronizedRef,
} from 'effect';
import stableStringify from 'safe-stable-stringify';
import { z } from 'zod';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { resolveChildRunConcurrencyBudget } from '@agent/runtime/childRunBudget';
import { offeredBy } from '@agent/runtime/loop/step';
import { formatSubagentDelivery } from '@agent/runtime/subagentResults';
import { IssuingScript, requireToolRun } from '@agent/runtime/RunCall';
import type { RunToolCall, ScriptScope } from '@agent/runtime/RunCall';
import {
  isDocumentTaskConfig,
  aggregateId,
  AgentProposalSchema,
  type AgentProposal,
  toJsonValue,
  ToolError,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
  type ToolResult,
} from '@shared/schemas';
import { deriveToolInputPreview } from '@shared/tools/toolInputPreview';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { defineTool } from '@tools/core/define';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { errorResult, executed } from '@tools/core/result';
import { normalizeStructuredOutputSchema } from '@tools/structuredOutput';
import { truncatedHexId } from '@utils/core/idHash';
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { agentChildRunId, earlierChild, recoverAgentChild } from './agentChild';
import { selectAvailableDelegationModel } from './delegationAvailability';
import {
  executeSubagentInBand,
  SubagentDurabilityError,
} from './inBandSubagentRun';
import {
  memoriesField,
  rejectOversizedBibAttachments,
  rejectUnusableWorkingDirectory,
  resolveInvocationFileList,
  withToolUseSubagentHandoffInstruction,
  workingDirectoryField,
} from './inputFields';
import { decideDelegation, requireAgent } from './proposalFlow';
import {
  describeSubagentProgress,
  launchDetachedSubagent,
} from './subagentRun';

/** Most children one script may launch. */
const AGENT_CALL_LIMIT = 1000;

/** The call's `timeoutMs` passed: interrupting the wait stopped the child. */
class AgentTimedOut extends Data.TaggedError('AgentTimedOut')<{
  readonly timeoutMs: number;
}> {}

/** A list of file paths, empty when the call names none. */
export const fileList = (
  description: string,
): ReturnType<typeof nullishWithDefault<z.ZodArray<z.ZodString>>> =>
  nullishWithDefault(z.array(z.string()), []).describe(description);

/** The fields that name what an `agent` call runs and with which model. */
const LAUNCH_FIELDS = {
  prompt: z
    .string()
    .min(1, 'prompt is required')
    .describe(
      'The task, in plain prose. Name the files it concerns and copy every constraint the agent must follow: it does not see your conversation.',
    ),
  agentName: z
    .string()
    .min(1, 'agentName is required')
    .describe('The agent to run. It works with its own tools.'),
  model: z
    .string()
    .nullish()
    .describe(
      'Model reference, `@effort` suffix allowed (`@low` … `@max`, `@none`). Defaults to your current model when available.',
    ),
  schema: z
    .record(z.string(), z.unknown())
    .nullish()
    .describe(
      'A JSON Schema object: the agent finishes by submitting a value of it, returned as `structured`.',
    ),
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
  id: z
    .string()
    .nullish()
    .describe(
      'Tells apart two otherwise identical calls: a completed call is reused by a later one with the same prompt, options and files.',
    ),
  label: z.string().nullish().describe('A short title for the call’s card.'),
  timeoutMs: z
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000)
    .nullish()
    .describe('Stops the agent after this many milliseconds: `TimedOut`.'),
  background: z
    .boolean()
    .nullish()
    .describe(
      'In a script: return `{ runId }` at once; the result arrives as a follow-up. A direct call always runs in the background, except in a one-shot run.',
    ),
};
const AgentInputSchema = z.strictObject({ ...LAUNCH_FIELDS, ...CALL_FIELDS });
type AgentInput = z.infer<typeof AgentInputSchema>;

/**
 * One child launch as the shared core runs it: the agent and its prompt,
 * the files a document task revises (empty for a chat), and the script a
 * task's run opens on. `tool` names the launching tool in its reuse key and
 * its copy.
 */
export interface ChildLaunch {
  readonly tool: string;
  readonly agentName: string;
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
  /** A document task: the child opens on the approved agent's recipe (null
   *  for one with no task), and the proposal says it revises `files`. */
  readonly task: {
    readonly recipeFor: (chosen: AgentProposal) => AgentConfig['script'];
    readonly toolConfig: Record<string, unknown>;
  } | null;
}

/**
 * The request the `agent` calls of one script share: the first to ask opens
 * it, and a resumed script finds it, answered or still open, from its rows.
 * One the run's stop cancelled is asked again under a fresh id.
 */
const scriptRequest = (
  call: RunToolCall,
  script: ScriptScope,
  proposal: AgentProposal,
) =>
  Effect.gen(function* () {
    const { session, runId } = call.run;
    const prefix = `proposal-script-${truncatedHexId(`${call.responseId}\0${script.callId}`, 16)}`;
    const from = session.now();
    const rows = yield* session.readAggregate(aggregateId('run', runId), [
      'request.opened',
      'request.decided',
    ]);
    const opened = rows.flatMap((row) =>
      row.type === 'request.opened' && row.requestId.startsWith(prefix)
        ? [row.requestId]
        : [],
    );
    const last = opened.at(-1);
    if (last !== undefined) {
      const decided = rows.findLast(
        (row) => row.type === 'request.decided' && row.requestId === last,
      );
      if (decided?.type !== 'request.decided')
        // A plane that closes first decides nothing: the call stays in
        // flight, and the next resume finds the request still open.
        return yield* session.decisionFor(runId, last, from).pipe(
          Effect.map((row) => row.decision),
          Effect.catch((cause) =>
            Effect.logWarning(
              `The script's agent request ${last} closed without a decision; the call stays in flight and the next resume asks again.`,
            ).pipe(
              Effect.annotateLogs({ data: cause }),
              Effect.andThen(Effect.interrupt),
            ),
          ),
        );
      if (decided.decision.action !== 'cancel') return decided.decision;
    }
    const calls = yield* script.calls;
    return yield* call.requests.open({
      kind: 'proposal',
      data: {
        requestId:
          opened.length === 0 ? prefix : `${prefix}-${opened.length + 1}`,
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

/** The bytes behind a workflow call's files, hashed for its reuse key. */
const fingerprint = Effect.fn('agent.fingerprint')(function* (
  paths: readonly (readonly string[])[],
) {
  const fs = yield* FileSystem.FileSystem;
  const hash = createHash('sha256');
  for (const [group, files] of paths.entries())
    for (const [index, file] of files.entries()) {
      const bytes = yield* fs.readFile(file);
      hash.update(`${group}\0${index}\0${bytes.length}\0`);
      hash.update(bytes);
    }
  return hash.digest('hex');
});

/**
 * The runs whose completed calls a call may reuse (Q2): the run that issued
 * the `script` call, and the background script runs it launched. A call of
 * a background script's run reaches its parent and its siblings this way.
 */
const reuseScope = Effect.fn('agent.reuseScope')(function* (call: RunToolCall) {
  const { session, runId } = call.run;
  const view = yield* session.readView([]);
  const root =
    view.runs.get(runId)?.identity.kind === 'script'
      ? (view.runs.get(runId)?.parentId ?? runId)
      : runId;
  return [
    root,
    ...(view.runs.get(root)?.childIds ?? []).filter(
      (id) => view.runs.get(id)?.identity.kind === 'script',
    ),
  ];
});

/**
 * A completed call in the reuse scope whose key is `key`, or a refusal when
 * one of this same script holds it: two calls of one script that would
 * answer the same must say how they differ (`id`). Read from the runs'
 * `tool.result` rows; only an executed result carries a key.
 */
const reusable = Effect.fn('agent.reusable')(function* (
  call: RunToolCall,
  script: ScriptScope,
  key: string,
) {
  const siblings = yield* script.shared(
    'agent:keys',
    Effect.sync(() => new Map<string, string>()),
  );
  const callId = call.callId ?? '';
  // Claimed before the read below yields, so two calls of the script
  // issued together cannot both pass.
  const claimed = siblings.get(key);
  if (claimed !== undefined && claimed !== callId)
    return errorResult(
      'Another agent call of this script has the same prompt, options and files. Give each a distinct `id` to run both.',
      { name: 'DuplicateCall' },
    );
  siblings.set(key, callId);
  const rows = (yield* Effect.forEach(yield* reuseScope(call), (runId) =>
    call.run.session.readAggregate(aggregateId('run', runId), ['tool.result']),
  )).flat();
  const found = rows.flatMap((row) =>
    row.type === 'tool.result' &&
    row.payload.result.status === 'executed' &&
    row.payload.result.reuseKey === key
      ? [
          {
            responseId: row.payload.responseId,
            callId: row.payload.callId,
            result: row.payload.result,
          },
        ]
      : [],
  );
  const mine = `${script.callId}/`;
  // A sibling a resume handed back from its row never ran here to claim.
  if (
    found.some(
      (row) =>
        row.responseId === call.responseId &&
        row.callId.startsWith(mine) &&
        row.callId !== callId,
    )
  )
    return errorResult(
      'Another agent call of this script has the same prompt, options and files. Give each a distinct `id` to run both.',
      { name: 'DuplicateCall' },
    );
  const origin = found.at(-1);
  if (origin === undefined) return null;
  const from = origin.result.reusedFrom ?? origin.callId;
  return {
    ...origin.result,
    output: `Reused the result of call ${from}: nothing ran again.\n\n${origin.result.output ?? ''}`,
    reusedFrom: from,
  } satisfies ToolResult;
});

/** What an ended child becomes for its call: its envelope, or the error a
 *  script's `await` throws for it. */
function childResult(
  agentName: string,
  runId: RunId,
  result: RunEnd,
  key: string | undefined,
): ToolResult {
  if (result.outcome === 'cancelled')
    return errorResult(
      `The agent run ${runId} for '${agentName}' was stopped, so this call was skipped.`,
      {
        name: 'Skipped',
        summary: `Skipped '${agentName}'`,
        diagnostics: { reason: 'user', runId },
      },
    );
  if (result.outcome !== 'completed')
    return errorResult(
      `The agent run ${runId} for '${agentName}' ended ${result.outcome}${result.error?.message ? `: ${result.error.message}` : '.'}`,
      { name: 'AgentFailed', summary: `'${agentName}' failed` },
    );
  if (result.output.documents?.outputs.length === 0)
    return errorResult(
      `The document task run ${runId} for '${agentName}' completed without producing any output files.`,
      { name: 'AgentFailed', summary: `'${agentName}' produced nothing` },
    );
  return {
    ...executed(
      formatSubagentDelivery(agentName, result, { runId }),
      `Completed '${agentName}'`,
    ),
    value: toJsonValue({
      ...result.output,
      runId,
      outcome: result.outcome,
      cost: result.usage?.totalCost ?? 0,
    }),
    ...(key !== undefined && { reuseKey: key }),
  };
}

/**
 * One call. A script's awaited calls hold one of the session's child-run
 * budget for the whole call, taken first thing, so they start in the order
 * the script issued them and at most the budget run at once.
 */
export const launchChildAgent = Effect.fn('AgentTool.call')(function* (
  launch: ChildLaunch,
) {
  const call = yield* requireToolRun(launch.tool);
  const script = yield* IssuingScript;
  if (script === null || launch.background === true)
    return yield* agentCall(call, launch);
  const budget = yield* script.shared(
    'agent:budget',
    Effect.flatMap(
      resolveChildRunConcurrencyBudget(call.env.roots),
      (permits) => Semaphore.make(permits),
    ),
  );
  return yield* budget.withPermits(1)(agentCall(call, launch));
});

/** A child's run failed the call: timed out, or ended without an answer. */
function failedResult(agentName: string, error: Error): ToolResult {
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

const agentCall = Effect.fn('AgentTool.agentCall')(function* (
  call: RunToolCall,
  launch: ChildLaunch,
) {
  const { run } = call;
  const script = (yield* IssuingScript) ?? undefined;
  const { session, runId: parentRunId } = run;
  const agent = yield* requireAgent(call.env.roots, launch.agentName, run);
  const { task, files } = launch;
  const unusable = yield* rejectUnusableWorkingDirectory(
    call.env.roots,
    launch.workingDirectory ?? undefined,
  );
  if (unusable) return unusable;
  const outputSchema =
    launch.schema == null
      ? undefined
      : yield* Effect.try({
          try: () =>
            normalizeStructuredOutputSchema(launch.schema ?? {}).jsonSchema,
          catch: (error) =>
            new ToolError(
              `\`schema\` is not a supported object-root JSON Schema: ${toErrorMessage(error)}`,
            ),
        });
  // The call's files, resolved where they live: a run-storage file must be
  // this run's own or a declared output of a completed child of it; a
  // recipe's (a revision's figures and media, TeXRA's choice) pass as named.
  const recipe = isDocumentTaskConfig(run.config);
  const resolved = yield* Effect.exit(
    Effect.all(
      (
        [
          ['Input file', files.inputFiles],
          ['Context file', files.contextFiles],
          ['Media file', files.mediaFiles],
        ] as const
      ).map(([label, list]) =>
        recipe
          ? Effect.succeed(list.map((file) => ({ file, absolutePath: file })))
          : resolveInvocationFileList(session, parentRunId, label, list),
      ),
    ),
  );
  if (Exit.isFailure(resolved))
    return errorResult(toErrorMessage(Cause.squash(resolved.cause)));
  const [inputs = [], contexts = [], media = []] = resolved.value;
  const contextFiles = contexts.map(({ file }) => file);
  if (task !== null) {
    const oversized = yield* rejectOversizedBibAttachments(
      call.env.roots.workspace,
      contextFiles,
    ).pipe(Effect.mapError(ensureError));
    if (oversized) return oversized;
  }

  // Awaited in a script unless sent to the background, and always in a
  // one-shot run, which has no later turn for a follow-up to reach.
  const oneShot = run.toolPolicy.stopAfterCycle === true;
  const awaited =
    oneShot || (script !== undefined && launch.background !== true);
  // Q2: a completed call with the same prompt, options and file bytes. The
  // requested model, not the one availability resolves to, so a reuse does
  // not depend on which credentials are configured now.
  const fileBytes =
    awaited && script !== undefined
      ? yield* fingerprint(
          [inputs, contexts, media].map((group) =>
            group.map(({ absolutePath }) => absolutePath),
          ),
        )
      : null;
  const key =
    awaited && script !== undefined
      ? createHash('sha256')
          .update(
            stableStringify({
              tool: launch.tool,
              prompt: launch.prompt,
              agent: agent.name,
              model: launch.model ?? null,
              schema: outputSchema ?? null,
              ...files,
              toolConfig: task?.toolConfig ?? null,
              memories: launch.memories,
              workingDirectory: launch.workingDirectory ?? null,
              id: launch.id ?? null,
              files: fileBytes,
            }) ?? '',
          )
          .digest('hex')
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
      : work.pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(new AgentTimedOut({ timeoutMs })),
          }),
        );

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
      recoverAgentChild(call, {
        agentName: agent.name,
        notify,
        running,
      }),
    );
    if (Result.isFailure(recovered))
      return failedResult(agent.name, recovered.failure);
    const settled = recovered.success;
    if (settled.kind === 'unknown')
      return errorResult(
        `The outcome of agent run ${settled.runId} is unknown (${settled.reason}), and the call was skipped.`,
        { name: 'Skipped', diagnostics: { reason: 'outcome-unknown' } },
      );
    if (settled.kind === 'ended')
      return childResult(agent.name, settled.runId, settled.result, key);
  }

  // An unavailable model fails this call, which a script may catch (Q6).
  const selected = yield* Effect.exit(
    selectAvailableDelegationModel({
      requestedModel: launch.model,
      parentModel: (yield* SynchronizedRef.get(run.model)).modelId,
      settings: call.env.roots,
    }),
  );
  if (Exit.isFailure(selected))
    return errorResult(toErrorMessage(Cause.squash(selected.cause)), {
      name: 'ModelUnavailable',
    });
  const workingDirectory = launch.workingDirectory ?? call.env.workingDirectory;
  const proposal: AgentProposal = AgentProposalSchema.parse({
    agent: agent.name,
    agentSource: agent.source,
    model: selected.value,
    memories: launch.memories,
    ...(workingDirectory !== undefined && { workingDirectory }),
    task: task !== null,
    // A task's prompt is its instruction, a structured call answers through
    // its schema, and a recipe's call (app-written, a document revision's
    // whole prompt) reaches the agent verbatim: none takes a hand-off.
    instruction:
      task !== null || outputSchema !== undefined || recipe
        ? launch.prompt
        : withToolUseSubagentHandoffInstruction(
            launch.prompt,
            call.instruction,
          ),
    inputFiles: inputs.map(({ file }) => file),
    contextFiles,
    mediaFiles: media.map(({ file }) => file),
    outputFiles: files.outputFiles,
    // A task's file options reach the child as its tool configuration.
    ...(task !== null && { toolConfig: task.toolConfig }),
    ...(task === null && { rootUserInstruction: call.instruction }),
  });

  const decided = yield* decideDelegation(
    call,
    proposal,
    script === undefined
      ? undefined
      : script.shared('agent:request', scriptRequest(call, script, proposal)),
  );
  if ('status' in decided) {
    // An approval opened for editing stops the script's calls: the script
    // cannot continue on a task the user took over.
    if (script !== undefined && decided.status === 'executed')
      return errorResult(
        `The user opened this script's agent work for editing as a new task; '${agent.name}' did not run.`,
      );
    return decided;
  }
  // A script launches at most AGENT_CALL_LIMIT children, counted here,
  // just before a launch: a reused, recovered, refused or unavailable call
  // launches none, and a resume's replayed calls never reach here.
  if (script !== undefined) {
    const launches = yield* script.shared(
      'agent:launches',
      Effect.sync(() => ({ count: 0 })),
    );
    if (launches.count >= AGENT_CALL_LIMIT)
      return errorResult(
        `A script may launch at most ${AGENT_CALL_LIMIT} agents; '${agent.name}' did not run.`,
        { name: 'CallLimit' },
      );
    launches.count += 1;
  }

  // The proposal's `script` names the script that asked; the child's is set below.
  const { task: _task, script: _askingScript, ...approved } = decided.proposal;
  // An approval may pick another agent: a task's recipe is that agent's.
  const taskScript = task?.recipeFor(decided.proposal);
  if (taskScript === null)
    return errorResult(`'${approved.agent}' has no document task.`);
  const childApproval = decided.approvalMeta.childApproval ?? 'inherit';
  const inherit = (childRunId: RunId): void => {
    configureDelegatedChildApprovals(
      childRunId,
      parentRunId,
      childApproval,
      session,
    );
  };
  const configPayload = {
    ...approved,
    ...(outputSchema !== undefined && { outputSchema }),
    delegationAgentScope: run.delegationAgentScope,
    ...(taskScript != null && { script: taskScript }),
  };
  const parentOffered = yield* offeredBy(run);

  if (!awaited) {
    const runId = agentChildRunId(call);
    const receipt = yield* launchDetachedSubagent(call, configPayload, {
      runId,
      parentOffered,
      inheritChildRunApprovals: inherit,
      approvalMeta: decided.approvalMeta,
    });
    // What a script's `await` gets for a child sent to the background.
    return receipt.status === 'executed'
      ? { ...receipt, value: { runId } }
      : receipt;
  }
  const launched = yield* Effect.result(
    running(
      executeSubagentInBand({
        session,
        runId: agentChildRunId(call),
        parentRunId,
        configPayload,
        parentOffered,
        parentCard: call.logId,
        parentCallId: call.callId,
        onRunResolved: inherit,
        notify,
      }),
    ),
  );
  return Result.isFailure(launched)
    ? failedResult(approved.agent, launched.failure)
    : childResult(
        approved.agent,
        launched.success.runId,
        launched.success.result,
        key,
      );
});

/** The `agent` tool. */
export const agentTool = () =>
  defineTool({
    name: 'agent',
    requiresApproval: 'inBody',
    // A resumed call finds the child its earlier attempt launched and settles
    // from it, or resumes it under its own id: it never launches a second one.
    replay: 'safe',
    // A script's calls run beside each other, held to the child-run budget.
    ownsConcurrency: true,
    scriptGlobal: { positional: 'prompt' },
    // A script awaits the child's envelope, or `{ runId }` in the background.
    scriptReturns:
      "{ response: string; files: string[]; structured?: unknown; runId: string; outcome: 'completed'; cost: number } | { runId: string }",
    slow: true,
    description: `Run a named agent as a child of this run: it works with its own tools on the prompt you give it.

From a script, \`agent(prompt, opts)\` (the same as \`tools.agent({ prompt, ...opts })\`) waits for the child and resolves to its result: \`{ response, files, structured?, runId, outcome, cost }\`. It rejects with an Error named \`AgentFailed\`, \`TimedOut\`, or \`Skipped\` (the user stopped the child). With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up. A completed call is reused, not run again, by a later call in this run with the same prompt, options and file contents; give two otherwise identical calls of one script distinct \`id\`s.

Called directly, the child runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.

It returns the agent's final reply, or a \`schema\` value. Pick the agent whose description fits the task.`,
    schema: AgentInputSchema,
    execute: (input: AgentInput) =>
      launchChildAgent({
        tool: 'agent',
        agentName: input.agentName,
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
