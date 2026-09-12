import { Effect } from 'effect';
/**
 * Tools for delegating agent runs from tool-use agents.
 * - delegate_workflow: For workflow agents (structured file I/O, fixed-round full-document rewrite)
 * - delegate_agent: For tool-use agents (new delegation or resume via execution_id)
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue. One-shot/headless parent runs execute subagents in-band because there
 * is no later interactive follow-up turn to consume async delivery.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { RunHandle } from '@agent/runtime/RunHandle';
import {
  getRunContextRunId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import {
  describeFollowUpFailure,
  FOLLOW_UP_WAKE_FAILED_MESSAGE,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { createLog } from '@logger/logUtils';
import { effectRuntime } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import {
  AgentCategory,
  RunIdSchema,
  DEFAULT_TOOL_CONFIG,
  extractionShorthandToolConfig,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas';
import { requireLiveRun } from '@tools/contextHelpers';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  formatFollowUpInstruction,
  formatSubagentError,
} from './subagentResults';

// Local file imports
import { selectAvailableDelegationModel } from './delegationAvailability';
import { proposeAndExecute, requireVisibleAgent } from './proposalFlow';
import {
  assertWorkflowFilesExist,
  memoriesField,
  workingDirectoryField,
  withToolUseSubagentHandoffInstruction,
  rejectOversizedBibAttachments,
  WorkflowAgentInputSchema,
  type WorkflowAgentInput,
} from './inputFields';

const log = createLog('delegation');

/**
 * Deliver a terminal error to the orchestrator when a resumed subagent's wake
 * fails outright (no child-run loop is listening, and the generic host resume
 * port also failed) — without this, the resume tool call returns a normal
 * "queued" success and the orchestrator never hears back. Best-effort: a
 * failure delivering THIS message is logged, not re-thrown (this already runs
 * fire-and-forget off `resumeAgent`'s own return).
 */
const deliverResumeWakeFailure = Effect.fn('deliverResumeWakeFailure')(
  function* (
    handle: RunHandle,
    session: SessionHandle,
    runId: string,
    err: unknown,
  ): Effect.fn.Return<void, Error> {
    log.warn(
      `Failed to wake resumed subagent '${runId}': ${toErrorMessage(err)}`,
    );
    const msg = formatSubagentError(runId, handle.agentName, err);
    const targetRunId = handle.deliveryTarget;
    if (targetRunId === undefined) {
      log.warn(
        `The wake-failure error for '${runId}' has no parent to deliver to (detached).`,
      );
      return;
    }
    const delivery = yield* submitFollowUp(
      targetRunId,
      { text: msg, origin: 'subagent_result' },
      { session },
    );
    if (delivery.status === 'failed') {
      log.warn(
        `Also failed to deliver the wake-failure error for '${runId}' to the parent (${delivery.reason}).`,
      );
    }
  },
);

// ============================================================================
// delegate_workflow tool - for document processing agents
// ============================================================================

/** Tool for delegating tasks to workflow agents (document processing). */
export class WorkflowAgentTool extends defineTool({
  name: 'delegate_workflow',
  availabilityCategory: 'workflow',
  requiresApproval: true,
  // Static base text; the "Available agents:" line is resolved per run at the
  // resolveAgentTools boundary.
  description: `Delegate to a workflow agent. The agent rewrites every file you list in inputFiles, emitting one revised <document> per input. Use for whole-document operations: proofreading, polishing, applying reviews, adding derivations, merging revisions. For interactive tool use or selective edits, use delegate_agent instead.

Delegations run asynchronously. When subtasks are independent, launch them all in one turn and continue your own work. Each result arrives automatically as a follow-up message.

Available agents: loaded from the active roster at runtime.

Pick the agent whose description matches the task. Do not default to the first listed agent.

Available models: loaded from the active credentials at runtime.
Largest models for deep reasoning; long-context for lengthy tedious work; cost-effective for parallel routine work.

Optional auto-attach from the input LaTeX:
- extractFigures=true: pull \\includegraphics / \\begin{overpic} figures into mediaFiles.
- extractTikz=true: compile TikZ figures into standalone PDFs and attach.`,
  schema: WorkflowAgentInputSchema,
}) {
  protected async execute(
    input: WorkflowAgentInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const agent = requireVisibleAgent('workflow', input.agent);
    const agentName = agent.name;
    const { runId, context } = requireLiveRun('delegate_workflow');

    const model = await effectRuntime().runPromise(
      selectAvailableDelegationModel({
        requestedModel: input.model,
        parentModel: context.model,
      }),
    );

    await assertWorkflowFilesExist([
      { label: 'Input file', files: input.inputFiles },
      { label: 'Context file', files: input.contextFiles },
      { label: 'Media file', files: input.mediaFiles },
    ]);

    const oversizedBibRejection = await rejectOversizedBibAttachments(
      input.contextFiles,
    );
    if (oversizedBibRejection) return oversizedBibRejection;

    // Extraction flags map to toolConfig, flowing through the proposal UI and
    // into MediaExtractionNode → LatexMediaManager at runtime.
    const proposal = WorkflowAgentProposalSchema.parse({
      agentCategory: AgentCategory.Workflow,
      agent: agentName,
      agentSource: agent.source,
      model,
      instruction: input.instruction,
      inputFiles: input.inputFiles,
      contextFiles: input.contextFiles,
      mediaFiles: input.mediaFiles,
      outputFiles: input.outputFiles,
      toolConfig: {
        ...DEFAULT_TOOL_CONFIG,
        ...extractionShorthandToolConfig(input),
      },
      memories: input.memories,
    } satisfies WorkflowAgentProposal);

    // The call's signal is the wait's stop: aborted when this tool call is
    // interrupted, it interrupts the request fiber so `openRequest` closes a
    // pending request instead of leaving it approvable after the run stopped.
    return effectRuntime().runPromise(
      proposeAndExecute(
        currentSession(),
        context,
        getCurrentToolCallContext(),
        proposal,
        agentName,
        runId,
      ),
      { signal },
    );
  }
}

// ============================================================================
// delegate_agent tool - for interactive assistants
// ============================================================================

/** Schema for delegate_agent tool (tool-use agents). */
const DelegateAgentInputSchema = z
  .strictObject({
    agent: z
      .string()
      .nullish()
      .describe(
        'Name of the tool-use agent to delegate to. Required for new delegations; omit when resuming via execution_id.',
      ),
    model: z
      .string()
      .nullish()
      .describe(
        'Model short name from the Available models line. Omit unless the user explicitly requested a model; defaults to the current model when available.',
      ),
    instruction: z
      .string()
      .describe(
        'Plain prose instruction for the agent. For new delegations, include file paths naturally and copy every relevant parent constraint into this field: tool/network/file/approval limits, output format, and scope. The subagent does not automatically inherit the parent conversation or hidden constraints. For resumes, reference previous work freely because the subagent retains its full history.',
      ),
    memories: memoriesField,
    working_directory: workingDirectoryField,
    execution_id: RunIdSchema.nullish().describe(
      'If set, sends follow-up instructions to a tool-use subagent instead of starting a new one. Busy subagents queue the follow-up for their next turn. Use the run ID from the original delegation result or /executions.',
    ),
  })
  .refine((data) => Boolean(data.agent) !== Boolean(data.execution_id), {
    error:
      "Provide exactly one of 'agent' (to start a new delegation) or 'execution_id' (to resume an existing one), not both or neither.",
  });

type DelegateAgentInput = z.infer<typeof DelegateAgentInputSchema>;

/** Tool for delegating tasks to tool-use agents (interactive assistants). */
export class DelegateAgentTool extends defineTool({
  name: 'delegate_agent',
  availabilityCategory: 'toolUse',
  requiresApproval: true,
  // Static base text; the "Available agents:", "Available models:", and "Git
  // worktree support:" lines are resolved per run at the resolveAgentTools
  // boundary.
  description: `Delegate a task to a tool-use agent, or queue follow-up instructions for a tool-use subagent.

**New delegation** (no execution_id): Launches a new tool-use agent with its own tools (file reading, editing, search, bash). Tool-use agents can create entire documents, make targeted edits, perform research, or run multi-step investigations.

**Resume** (with execution_id): Sends follow-up instructions to a WAITING or still-running subagent. If the subagent is busy, the instruction is queued for its next turn. The subagent keeps its full history. Result arrives asynchronously like the original delegation.

Delegations run asynchronously. When subtasks are independent, launch them all in one turn and continue your own work. Each result arrives automatically as a follow-up message.

Available agents: loaded from the active roster at runtime.

Agent selection: choose the most specific agent whose description matches the task.

Available models: loaded from the active credentials at runtime.
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Example (resume): execution_id=3f9a1c7e2b4d, instruction="Also fix the bibliography slide formatting."

Git worktree support: resolved from the active workspace at runtime.`,
  schema: DelegateAgentInputSchema,
}) {
  protected async execute(
    input: DelegateAgentInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    // Resume path: execution_id is set
    if (input.execution_id) {
      return effectRuntime().runPromise(
        this.resumeAgent(
          input.execution_id,
          input.instruction,
          currentSession(),
          getRunContextRunId(tryUseRunContext()),
        ),
      );
    }

    // New-delegation path: the schema's refine() guarantees exactly one of
    // agent/execution_id is set, so agent is defined here — refine() doesn't
    // narrow types, hence the assertion.
    const agent = requireVisibleAgent('toolUse', input.agent!);
    const agentName = agent.name;

    const { runId, context } = requireLiveRun('delegate_agent');

    const model = await effectRuntime().runPromise(
      selectAvailableDelegationModel({
        requestedModel: input.model,
        parentModel: context.model,
      }),
    );
    const rootUserInstruction = getCurrentToolCallContext()?.userInstruction;

    // Construct tool-use proposal (no file fields)
    const proposal = ToolUseAgentProposalSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: agentName,
      agentSource: agent.source,
      model,
      instruction: withToolUseSubagentHandoffInstruction(
        input.instruction,
        rootUserInstruction,
      ),
      rootUserInstruction,
      memories: input.memories,
      workingDirectory: input.working_directory,
    } satisfies ToolUseAgentProposal);

    // The call's signal is the wait's stop: aborted when this tool call is
    // interrupted, it interrupts the request fiber so `openRequest` closes a
    // pending request instead of leaving it approvable after the run stopped.
    return effectRuntime().runPromise(
      proposeAndExecute(
        currentSession(),
        context,
        getCurrentToolCallContext(),
        proposal,
        agentName,
        runId,
      ),
      { signal },
    );
  }

  /** Queue follow-up instructions for a tool-use subagent. */
  private readonly resumeAgent = Effect.fn('DelegateAgentTool.resumeAgent')(
    function* (
      runId: RunId,
      instruction: string,
      session: SessionHandle,
      callerRunId: RunId | undefined,
    ): Effect.fn.Return<ToolResult, Error> {
      const handle = session.runs.getHandle(runId);
      if (!handle) {
        return yield* Effect.fail(
          new Error(
            `Run '${runId}' not found. Use the executions tool to check status.`,
          ),
        );
      }

      if (handle.category !== 'toolUse') {
        return yield* Effect.fail(
          new Error(
            `Run '${runId}' is a workflow agent. Only tool-use subagents can be resumed.`,
          ),
        );
      }

      // Results route to the handle's parent. A detached subagent delivers
      // nowhere, and a subagent of another orchestrator reports to that
      // orchestrator, not the caller. Fail fast instead of silently queueing
      // instructions whose results would never come back here.
      if (!handle.isChild) {
        return yield* Effect.fail(
          new Error(
            `Run '${runId}' was detached from its orchestrator and now runs top-level. Its results can no longer be delivered back to this session. Start a new delegation instead.`,
          ),
        );
      }
      if (callerRunId && !handle.isOwnedBy(callerRunId)) {
        return yield* Effect.fail(
          new Error(
            `Run '${runId}' belongs to a different orchestrator session. Its results would be delivered there, not here. Start a new delegation instead.`,
          ),
        );
      }

      const framedInstruction = formatFollowUpInstruction(instruction);
      const result = yield* submitFollowUp(handle.runId, framedInstruction, {
        session,
      });
      if (result.status === 'failed') {
        return yield* Effect.fail(
          new Error(
            `Follow-up for '${handle.agentName}' was not accepted (${result.reason}): ${describeFollowUpFailure(result.reason)}`,
          ),
        );
      }
      if (result.status === 'queued' && result.wake === 'failed') {
        // The instruction is in the subagent's queue; only its wake failed.
        // The parent learns of that through its own follow-up queue as well,
        // the same way a child's turn failure reaches it.
        yield* Effect.forkDetach(
          deliverResumeWakeFailure(
            handle,
            session,
            runId,
            new Error(
              'The subagent could not be resumed to process the follow-up.',
            ),
          ).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                log.warn('Could not deliver the subagent wake failure.', {
                  data: error,
                });
              }),
            ),
          ),
        );
        return executed(
          [
            `Follow-up instruction queued for '${handle.agentName}', but the subagent could not be resumed. ${FOLLOW_UP_WAKE_FAILED_MESSAGE}`,
            `Run ID: ${runId}`,
          ].join('\n'),
          `Follow-up queued for '${handle.agentName}' (resume failed)`,
        );
      }

      if (result.status === 'sent') {
        return executed(
          [
            `Follow-up instruction sent to '${handle.agentName}'. The subagent will process it and deliver a new result automatically.`,
            `Run ID: ${runId}`,
          ].join('\n'),
          `Follow-up sent to '${handle.agentName}'`,
        );
      }
      return executed(
        [
          `Follow-up instruction queued for '${handle.agentName}'. The subagent will process it and deliver a new result automatically.`,
          `Run ID: ${runId}`,
        ].join('\n'),
        `Follow-up queued for '${handle.agentName}'`,
      );
    },
  );
}
