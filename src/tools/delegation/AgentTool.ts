/**
 * The `agent` tool: run a named agent as a child of the calling run. It
 * takes the options of `delegate_agent`, `delegate_workflow` and a workflow
 * script's `agent()`, and the named agent decides which apply.
 *
 * Called from a script it awaits the child and returns the child's envelope
 * (`{ ...output, outcome, cost }`), unless `background` detaches it; called
 * directly it detaches, as a delegation always has, except in a one-shot
 * run, which waits. The script's `agent` calls share one approval request
 * showing its source (Q5); a direct call proposes itself. A completed
 * awaited call is reused by a later call with the same key in the same run
 * (Q2), and a call cut short finds the child its attempt launched
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
import { resolveChildRunConcurrencyBudget } from '@agent/runtime/childRunBudget';
import { offeredBy } from '@agent/runtime/loop/step';
import { formatSubagentDelivery } from '@agent/runtime/subagentResults';
import { ToolCall, type ScriptScope } from '@agent/runtime/ToolCall';
import {
  aggregateId,
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  extractionShorthandToolConfig,
  toJsonValue,
  ToolError,
  type RunEnd,
  type RunId,
  type SubagentProgressUpdate,
  type ToolResult,
  ToolUseAgentProposalSchema,
  type ToolUseAgentProposal,
  WorkflowAgentProposalSchema,
  type WorkflowAgentProposal,
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
import {
  agentChildRunId,
  earlierChild,
  launchAgentChild,
  recoverAgentChild,
} from './agentChild';
import { selectAvailableDelegationModel } from './delegationAvailability';
import { SubagentDurabilityError } from './inBandSubagentRun';
import {
  memoriesField,
  rejectOversizedBibAttachments,
  rejectUnusableWorkingDirectory,
  resolveInvocationFileList,
  withToolUseSubagentHandoffInstruction,
  workingDirectoryField,
} from './inputFields';
import {
  decideDelegation,
  requireDelegationParent,
  requireWorkflowOrToolUseAgent,
  type DelegationParent,
} from './proposalFlow';
import {
  describeSubagentProgress,
  launchDetachedSubagent,
} from './subagentRun';

/** The call's `timeoutMs` passed: interrupting the wait stopped the child. */
class AgentTimedOut extends Data.TaggedError('AgentTimedOut')<{
  readonly timeoutMs: number;
}> {}

const fileList = (description: string) =>
  nullishWithDefault(z.array(z.string()), []).describe(description);

const AgentInputSchema = z.strictObject({
  prompt: z
    .string()
    .min(1, 'prompt is required')
    .describe(
      'The task, in plain prose. Name the files it concerns and copy every constraint the agent must follow: it does not see your conversation.',
    ),
  agentName: z
    .string()
    .min(1, 'agentName is required')
    .describe(
      'The agent to run. A workflow agent rewrites `inputFiles`; a tool-use agent works with its own tools.',
    ),
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
      'A JSON Schema object: the tool-use agent finishes by submitting a value of it, returned as `structured`.',
    ),
  inputFiles: fileList(
    'Workflow agents: the files it rewrites, one revised document each.',
  ),
  contextFiles: fileList(
    'Workflow agents: read-only context (guidance, .bib, .sty). Say in the prompt what each is for.',
  ),
  mediaFiles: fileList('Workflow agents: images, figures, PDFs or audio.'),
  outputFiles: fileList(
    'Workflow agents: output paths, a subset of `inputFiles`. Empty for the default outputs.',
  ),
  extractFigures: z
    .boolean()
    .nullish()
    .describe(
      'Workflow agents: attach the figures the input LaTeX includes as media.',
    ),
  extractTikz: z
    .boolean()
    .nullish()
    .describe(
      'Workflow agents: compile the input LaTeX TikZ figures and attach them.',
    ),
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
});
type AgentInput = z.infer<typeof AgentInputSchema>;

const WORKFLOW_ONLY = [
  'inputFiles',
  'contextFiles',
  'mediaFiles',
  'outputFiles',
] as const;

/** The option an agent of `category` cannot take, named. */
function optionMisfit(
  input: AgentInput,
  category: AgentCategory,
): string | null {
  if (category === AgentCategory.Workflow) {
    if (input.schema != null)
      return `'${input.agentName}' is a workflow agent: \`schema\` needs a tool-use agent.`;
    if (input.working_directory !== undefined)
      return `'${input.agentName}' is a workflow agent: \`working_directory\` needs a tool-use agent.`;
    if (input.inputFiles.length === 0)
      return `'${input.agentName}' is a workflow agent: pass the files it rewrites as \`inputFiles\`.`;
    return null;
  }
  const misfit = [
    ...WORKFLOW_ONLY.filter((field) => input[field].length > 0),
    ...(input.extractFigures != null ? ['extractFigures'] : []),
    ...(input.extractTikz != null ? ['extractTikz'] : []),
  ];
  return misfit.length === 0
    ? null
    : `'${input.agentName}' is a tool-use agent: ${misfit.map((field) => `\`${field}\``).join(', ')} need a workflow agent.`;
}

/**
 * The request the `agent` calls of one script share: the first to ask opens
 * it, and a resumed script finds it, answered or still open, from its rows.
 * One the run's stop cancelled is asked again under a fresh id.
 */
const scriptRequest = (
  call: DelegationParent,
  script: ScriptScope,
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
) =>
  Effect.gen(function* () {
    const { session, runId } = call.run;
    const prefix = `proposal-script-${truncatedHexId(`${call.responseId ?? ''}\0${script.callId}`, 16)}`;
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
    const { requests } = call;
    if (requests === undefined)
      return yield* Effect.die(
        new Error('A script request is raised outside its tool call.'),
      );
    const calls = yield* script.calls;
    return yield* requests.open({
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
 * A completed call of this run whose key is `key`, or a refusal when one of
 * this same script holds it: two calls of one script that would answer the
 * same must say how they differ (`id`). Read from the run's `tool.result`
 * rows; only an executed result carries a key.
 */
const reusable = Effect.fn('agent.reusable')(function* (
  call: DelegationParent,
  script: ScriptScope,
  key: string,
) {
  const siblings = yield* script.shared(
    'agent:keys',
    Effect.sync(() => new Map<string, string>()),
  );
  const callId = call.toolCallId ?? '';
  const claimed = siblings.get(key);
  const rows = yield* call.run.session.readAggregate(
    aggregateId('run', call.run.runId),
    ['tool.result'],
  );
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
  if (
    (claimed !== undefined && claimed !== callId) ||
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
  siblings.set(key, callId);
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
  if (
    result.output.category === 'workflow' &&
    result.output.outputs.length === 0
  )
    return errorResult(
      `The workflow agent run ${runId} for '${agentName}' completed without producing any output files.`,
      { name: 'AgentFailed', summary: `'${agentName}' produced nothing` },
    );
  return {
    ...executed(
      formatSubagentDelivery(agentName, result, { runId }),
      `Completed '${agentName}'`,
    ),
    value: toJsonValue({
      ...result.output,
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
const executeAgentTool = Effect.fn('AgentTool.call')(function* (
  input: AgentInput,
) {
  const call = yield* requireDelegationParent('agent', yield* ToolCall);
  const { script } = call;
  if (script === undefined || input.background === true)
    return yield* agentCall(call, input);
  const budget = yield* script.shared(
    'agent:budget',
    Effect.flatMap(resolveChildRunConcurrencyBudget(call.roots), (permits) =>
      Semaphore.make(permits),
    ),
  );
  return yield* budget.withPermits(1)(agentCall(call, input));
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
  call: DelegationParent,
  input: AgentInput,
) {
  const { run, script } = call;
  const { session, runId: parentRunId } = run;
  const scope = run.delegationAgentScope ?? undefined;
  const agent = yield* requireWorkflowOrToolUseAgent(
    call.roots,
    input.agentName,
    scope,
  );
  const workflow = agent.category === AgentCategory.Workflow;
  const misfit = optionMisfit(input, agent.category);
  if (misfit !== null) return errorResult(misfit);
  const unusable = yield* rejectUnusableWorkingDirectory(
    call.roots,
    input.working_directory,
  );
  if (unusable) return unusable;
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

  // A workflow agent's files, resolved where they live: a run-storage file
  // must be a declared output of a completed child of this run.
  const resolved = workflow
    ? yield* Effect.exit(
        Effect.all(
          (
            [
              ['Input file', input.inputFiles],
              ['Context file', input.contextFiles],
              ['Media file', input.mediaFiles],
            ] as const
          ).map(([label, files]) =>
            resolveInvocationFileList(session, parentRunId, label, files),
          ),
        ),
      )
    : null;
  if (resolved !== null && Exit.isFailure(resolved))
    return errorResult(toErrorMessage(Cause.squash(resolved.cause)));
  const [inputs = [], contexts = [], media = []] =
    resolved === null ? [] : resolved.value;
  const contextFiles = contexts.map(({ file }) => file);
  if (workflow) {
    const oversized = yield* rejectOversizedBibAttachments(
      call.roots.workspace,
      contextFiles,
    ).pipe(Effect.mapError(ensureError));
    if (oversized) return oversized;
  }

  // Awaited in a script unless sent to the background, and always in a
  // one-shot run, which has no later turn for a follow-up to reach.
  const oneShot = run.toolPolicy.stopAfterCycle === true;
  const awaited =
    oneShot || (script !== undefined && input.background !== true);
  const id = {
    responseId: call.responseId ?? '',
    callId: call.toolCallId ?? parentRunId,
  };
  const attempt = call.attempt ?? 1;

  // Q2: a completed call with the same prompt, options and file bytes. The
  // requested model, not the one availability resolves to, so a reuse does
  // not depend on which credentials are configured now.
  const files =
    awaited && script !== undefined && workflow
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
              tool: 'agent',
              prompt: input.prompt,
              agent: agent.name,
              model: input.model ?? null,
              schema: outputSchema ?? null,
              inputFiles: input.inputFiles,
              contextFiles: input.contextFiles,
              mediaFiles: input.mediaFiles,
              outputFiles: input.outputFiles,
              extractFigures: input.extractFigures ?? null,
              extractTikz: input.extractTikz ?? null,
              memories: input.memories,
              workingDirectory: input.working_directory ?? null,
              id: input.id ?? null,
              files,
            }) ?? '',
          )
          .digest('hex')
      : undefined;
  if (key !== undefined && script !== undefined) {
    const reused = yield* reusable(call, script, key);
    if (reused !== null) return reused;
  }

  const notify = (update: SubagentProgressUpdate): void => {
    const line = describeSubagentProgress(agent.name, update);
    if (line) run.logger.info(line);
  };
  const timeoutMs = input.timeoutMs ?? undefined;
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
    const earlier = yield* earlierChild(session, parentRunId, id, attempt);
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
        id,
        attempt,
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
      requestedModel: input.model,
      parentModel: (yield* SynchronizedRef.get(run.model)).modelId,
      settings: call.roots,
    }),
  );
  if (Exit.isFailure(selected))
    return errorResult(toErrorMessage(Cause.squash(selected.cause)), {
      name: 'ModelUnavailable',
    });
  const workingDirectory = input.working_directory ?? call.workingDirectory;
  const shared = {
    agent: agent.name,
    agentSource: agent.source,
    model: selected.value,
    memories: input.memories,
    ...(workingDirectory !== undefined && { workingDirectory }),
  };
  const proposal: WorkflowAgentProposal | ToolUseAgentProposal = workflow
    ? WorkflowAgentProposalSchema.parse({
        ...shared,
        agentCategory: AgentCategory.Workflow,
        instruction: input.prompt,
        inputFiles: inputs.map(({ file }) => file),
        contextFiles,
        mediaFiles: media.map(({ file }) => file),
        outputFiles: input.outputFiles,
        // The extraction flags reach the child as its tool configuration.
        toolConfig: {
          ...DEFAULT_TOOL_CONFIG,
          ...extractionShorthandToolConfig(input),
        },
      })
    : ToolUseAgentProposalSchema.parse({
        ...shared,
        agentCategory: AgentCategory.ToolUse,
        // A structured call answers through its schema, not a hand-off.
        instruction:
          outputSchema === undefined
            ? withToolUseSubagentHandoffInstruction(
                input.prompt,
                call.userInstruction,
              )
            : input.prompt,
        rootUserInstruction: call.userInstruction,
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
  const approved = decided.proposal;
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
    ...(scope !== undefined && { delegationAgentScope: scope }),
  };
  const parentOffered = yield* offeredBy(run);

  if (!awaited)
    return yield* launchDetachedSubagent(call, configPayload, {
      parentRunId,
      runId: agentChildRunId(parentRunId, id, attempt),
      parentOffered,
      inheritChildRunApprovals: inherit,
      approvalMeta: decided.approvalMeta,
    });
  const launched = yield* Effect.result(
    running(
      launchAgentChild(call, {
        id,
        attempt,
        prepare: () =>
          Effect.succeed({
            configPayload,
            parentRunId,
            session,
            parentOffered,
            onRunResolved: inherit,
            notify,
          }),
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

export const AgentTool = defineTool({
  name: 'agent',
  requiresApproval: 'inBody',
  // A resumed call finds the child its earlier attempt launched and settles
  // from it, or resumes it under its own id: it never launches a second one.
  replay: 'safe',
  // A script's calls run beside each other, held to the child-run budget.
  ownsConcurrency: true,
  scriptGlobal: { positional: 'prompt' },
  slow: true,
  description: `Run a named agent as a child of this run.

From a script, \`agent(prompt, opts)\` (the same as \`tools.agent({ prompt, ...opts })\`) waits for the child and resolves to its result: \`{ category, response | outputs, structured?, outcome, cost }\`. It rejects with an Error named \`AgentFailed\`, \`TimedOut\`, or \`Skipped\` (the user stopped the child). With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up. A completed call is reused, not run again, by a later call in this run with the same prompt, options and file contents; give two otherwise identical calls of one script distinct \`id\`s.

Called directly, the child runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.

A workflow agent rewrites every file in \`inputFiles\`, one revised document each; a tool-use agent works with its own tools and returns its final reply, or a \`schema\` value. Pick the agent whose description fits the task.`,
  schema: AgentInputSchema,
  execute: executeAgentTool,
});
