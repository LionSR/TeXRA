/**
 * Tools for delegating agent executions from tool-use agents.
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
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import {
  getRunContextStreamId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { deliverChildRunFollowUp } from '@agent/followUp/childRunDelivery';
import * as logger from '@logger/logUtils';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import { requireRunStream } from '@tools/contextHelpers';
import { defineTool } from '@tools/core/define';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  formatFollowUpInstruction,
  formatSubagentError,
} from './subagentResults';

// Local file imports
import {
  proposeAndExecute,
  requireVisibleAgent,
  selectAvailableDelegationModel,
} from './proposalFlow';
import {
  assertWorkflowFilesExist,
  memoriesField,
  workingDirectoryField,
  withToolUseSubagentHandoffInstruction,
  rejectOversizedBibAttachments,
  WorkflowAgentInputSchema,
  type WorkflowAgentInput,
} from './inputFields';

const LOG_CHANNEL = 'delegation';

/**
 * Deliver a terminal error to the orchestrator when a resumed subagent's wake
 * fails outright (no child-run loop is listening, and the generic host resume
 * port also failed) — without this, the resume tool call returns a normal
 * "queued" success and the orchestrator never hears back. Best-effort: a
 * failure delivering THIS message is logged, not re-thrown (this already runs
 * fire-and-forget off `resumeAgent`'s own return).
 */
async function deliverResumeWakeFailure(
  handle: AgentExecutionHandle,
  session: SessionHandle,
  executionId: string,
  err: unknown,
): Promise<void> {
  logger.warn(
    LOG_CHANNEL,
    `Failed to wake resumed subagent '${executionId}': ${toErrorMessage(err)}`,
  );
  const msg = formatSubagentError(executionId, handle.agentName, err);
  const delivery = await deliverChildRunFollowUp({
    targetStreamId: handle.parentStreamId,
    followUp: { text: msg, origin: 'subagent_result' },
    session,
  });
  if (delivery.kind !== 'delivered') {
    logger.warn(
      LOG_CHANNEL,
      `Also failed to deliver the wake-failure error for '${executionId}' to the parent (${delivery.kind}).`,
    );
  }
}

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

Available models: loaded from the active API mode at runtime.
Largest models for deep reasoning; long-context for lengthy tedious work; cost-effective for parallel routine work.

Optional auto-attach from the input LaTeX:
- extractFigures=true: pull \\includegraphics / \\begin{overpic} figures into mediaFiles.
- extractTikz=true: compile TikZ figures into standalone PDFs and attach.`,
  schema: WorkflowAgentInputSchema,
}) {
  protected async execute(input: WorkflowAgentInput): Promise<ToolResult> {
    const agent = requireVisibleAgent('workflow', input.agent);
    const agentName = agent.name;
    const { streamId, context } = requireRunStream('delegate_workflow');

    const model = await selectAvailableDelegationModel({
      requestedModel: input.model,
      parentModel: context.model,
    });

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
        autoExtractFigure: input.extractFigures ?? false,
        autoExtractTikzFigure: input.extractTikz ?? false,
      },
      memories: input.memories,
    } satisfies WorkflowAgentProposal);

    return proposeAndExecute(proposal, agentName, streamId);
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
    execution_id: z
      .string()
      .nullish()
      .describe(
        'If set, sends follow-up instructions to a tool-use subagent instead of starting a new one. Busy subagents queue the follow-up for their next turn. Use the execution ID from the original delegation result or /executions.',
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

Available models: loaded from the active API mode at runtime.
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Example (resume): execution_id=exec_abc123, instruction="Also fix the bibliography slide formatting."

Git worktree support: resolved from the active workspace at runtime.`,
  schema: DelegateAgentInputSchema,
}) {
  protected async execute(input: DelegateAgentInput): Promise<ToolResult> {
    // Resume path: execution_id is set
    if (input.execution_id) {
      return this.resumeAgent(input.execution_id, input.instruction);
    }

    // New-delegation path: the schema's refine() guarantees exactly one of
    // agent/execution_id is set, so agent is defined here — refine() doesn't
    // narrow types, hence the assertion.
    const agent = requireVisibleAgent('toolUse', input.agent!);
    const agentName = agent.name;

    const { streamId, context } = requireRunStream('delegate_agent');

    const model = await selectAvailableDelegationModel({
      requestedModel: input.model,
      parentModel: context.model,
    });
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

    return proposeAndExecute(proposal, agentName, streamId);
  }

  /** Queue follow-up instructions for a tool-use subagent. */
  private async resumeAgent(
    executionId: string,
    instruction: string,
  ): Promise<ToolResult> {
    const parentContext = tryUseRunContext();
    const session = currentSession();
    const handle = session.executions.getHandle(executionId);
    if (!(handle instanceof AgentExecutionHandle)) {
      throw new Error(
        `Execution '${executionId}' not found or not an agent execution. Use the executions tool to check status.`,
      );
    }

    if (handle.category !== 'toolUse') {
      throw new Error(
        `Execution '${executionId}' is a workflow agent. Only tool-use subagents can be resumed.`,
      );
    }

    // Results route to handle.parentStreamId — a detached subagent (parent ===
    // child) delivers nowhere, and a subagent of another orchestrator reports
    // to that orchestrator, not the caller. Fail fast instead of silently
    // queueing instructions whose results would never come back here.
    if (!handle.isChildExecution) {
      throw new Error(
        `Execution '${executionId}' was detached from its orchestrator and now runs top-level. Its results can no longer be delivered back to this session. Start a new delegation instead.`,
      );
    }
    const callerStreamId = getRunContextStreamId(parentContext);
    if (callerStreamId && !handle.isOwnedBy(callerStreamId)) {
      throw new Error(
        `Execution '${executionId}' belongs to a different orchestrator session. Its results would be delivered there, not here. Start a new delegation instead.`,
      );
    }

    const framedInstruction = formatFollowUpInstruction(instruction);
    const result = await submitFollowUp(
      handle.childStreamId,
      framedInstruction,
      {
        session,
      },
    );
    if (
      result.status === 'dropped' ||
      (result.status === 'queued' && result.continuation === 'resume_failed')
    ) {
      void deliverResumeWakeFailure(
        handle,
        session,
        executionId,
        new Error(
          'The subagent follow-up could not be delivered to a live or recovered continuation.',
        ),
      );
    }

    switch (result.status) {
      case 'sent':
        return executed(
          [
            `Follow-up instruction sent to '${handle.agentName}'. The subagent will process it and deliver a new result automatically.`,
            `Execution ID: ${executionId}`,
          ].join('\n'),
          `Follow-up sent to '${handle.agentName}'`,
        );
      case 'queued':
        return executed(
          [
            `Follow-up instruction queued for '${handle.agentName}' (${result.reason}). The subagent will process it and deliver a new result automatically.`,
            `Execution ID: ${executionId}`,
          ].join('\n'),
          `Follow-up queued for '${handle.agentName}'`,
        );
      case 'no_session':
        throw new Error(
          `No active session for '${handle.agentName}' (stream status: ${result.streamStatus ?? 'unknown'}). The subagent may have stopped or its session expired.`,
        );
      case 'dropped':
        throw new Error(
          `No continuation owner is available for '${handle.agentName}'.`,
        );
      case 'duplicate':
        // resumeAgent instructions carry no delivery id, so the admission
        // boundary never flags them; reachable only if a future caller adds
        // one — in which case the instruction was already admitted once.
        return executed(
          [
            `The identical follow-up was already delivered to '${handle.agentName}'.`,
            `Execution ID: ${executionId}`,
          ].join('\n'),
          `Follow-up already delivered to '${handle.agentName}'`,
        );
    }
  }
}
