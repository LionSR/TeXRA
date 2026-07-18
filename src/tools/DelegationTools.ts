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

// Local imports - agent
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
import { isChildRunLoopActive } from '@agent/runtime/childRunLoop';
import {
  sendFollowUp,
  wakeQueuedFollowUpStream,
} from '@agent/followUp/ToolUseFollowUp';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - tools
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import {
  formatFollowUpInstruction,
  formatSubagentError,
} from '@tools/subagentResults';
import { deliverChildRunFollowUp } from '@tools/childRunDelivery';
import { requireRunStream } from '@tools/contextHelpers';
import { defineTool } from '@tools/core/define';

// Local imports - utils
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - delegation
import {
  proposeAndExecute,
  requireVisibleAgent,
  selectAvailableDelegationModel,
} from './delegation/proposalFlow';
import {
  memoriesField,
  workingDirectoryField,
  withToolUseSubagentHandoffInstruction,
  rejectOversizedBibAttachments,
  WorkflowAgentInputSchema,
  type WorkflowAgentInput,
} from './delegation/inputFields';
import { assertWorkflowFilesExist } from './delegation/workflowFileValidation';

export { rejectOversizedBibAttachments } from './delegation/inputFields';
export type { WorkflowAgentInput };

const LOG_CHANNEL = 'delegation';
logger.initialize(LOG_CHANNEL);

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
    wake: true,
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
  requiresApproval: true,
  // Static base text; the "Available agents:" line is resolved per run at the
  // resolveAgentTools boundary.
  description: `Delegate to a workflow agent. The agent rewrites every file you list in inputFiles, emitting one revised <document> per input. Use for whole-document operations: proofreading, polishing, applying reviews, adding derivations, merging revisions. For interactive tool use or selective edits, use delegate_agent instead.

Available agents: loaded from the active roster at runtime.

Pick the agent whose description matches the task — don't default to correct. correct is for proofreading only. For applying review suggestions use apply; for new derivations use devise; for instruction-driven rewriting use polish; for critical review use criticize.

Available models: loaded from the active API mode at runtime.
Largest models for deep reasoning; long-context for lengthy tedious work; cost-effective for parallel routine work.

Optional auto-attach from the input LaTeX:
- extractFigures=true: pull \\includegraphics / \\begin{overpic} figures into mediaFiles.
- extractTikz=true: compile TikZ figures into standalone PDFs and attach.

Example: agent=correct, inputFiles=["paper.tex"], extractFigures=true, instruction="Quantum error correction paper. Fix grammar, tighten sentences, keep terminology consistent — especially in the abstract and intro."`,
  schema: WorkflowAgentInputSchema,
}) {
  protected async execute(input: WorkflowAgentInput): Promise<ToolResult> {
    const agent = requireVisibleAgent('workflow', input.agent);
    const agentName = agent.name;
    const { streamId, context } = requireRunStream('delegate_workflow');

    const model = await selectAvailableDelegationModel({
      requestedModel: input.model,
      parentModel: context.model,
      agentCategory: AgentCategory.Workflow,
    });

    await assertWorkflowFilesExist([
      { label: 'Input file', files: input.inputFiles },
      { label: 'Context file', files: input.contextFiles },
      { label: 'Media file', files: input.mediaFiles },
    ]);

    const oversizedBibRejection = await rejectOversizedBibAttachments(input);
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
        'Plain prose instruction for the agent. For new delegations, include file paths naturally and copy every relevant parent constraint into this field: tool/network/file/approval limits, output format, and scope. The subagent does not automatically inherit the parent conversation or hidden constraints. For resumes, reference previous work freely — the subagent retains its full history.',
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
      "Provide exactly one of 'agent' (to start a new delegation) or 'execution_id' (to resume an existing one) — not both, not neither.",
  });

export type DelegateAgentInput = z.infer<typeof DelegateAgentInputSchema>;

/** Tool for delegating tasks to tool-use agents (interactive assistants). */
export class DelegateAgentTool extends defineTool({
  name: 'delegate_agent',
  requiresApproval: true,
  // Static base text; the "Available agents:", "Available models:", and "Git
  // worktree support:" lines are resolved per run at the resolveAgentTools
  // boundary.
  description: `Delegate a task to a tool-use agent, or queue follow-up instructions for a tool-use subagent.

**New delegation** (no execution_id): Launches a new tool-use agent with its own tools (file reading, editing, search, bash). Tool-use agents are versatile—they can create entire documents, make targeted edits, perform research, or run multi-step investigations.

**Resume** (with execution_id): Sends follow-up instructions to a WAITING or still-running subagent. If the subagent is busy, the instruction is queued for its next turn. The subagent keeps its full history. Result arrives asynchronously like the original delegation.

When a subagent result is delivered, preserve its stated evidence, tool names, and caveats accurately; do not substitute or invent methods while summarizing it for the user.

Available agents: loaded from the active roster at runtime.

Agent selection: choose the most specific agent whose description matches the task. Specialized agents have domain-specific tools and focused prompts that produce better results for matching tasks. When using a general-purpose agent, state why the work does not map cleanly to a listed specialist.

Available models: loaded from the active API mode at runtime.
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Example (new, specialized): agent=research, instruction="Derive the asymptotic expansion of the partition function in appendix_A.tex using saddle-point methods. Verify with Wolfram."
Example (new, targeted LaTeX repair): agent=latexFixer, instruction="Fix the unresolved citation commands on slides 3 and 7 in slides/talk.tex using refs.bib."
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
      agentCategory: AgentCategory.ToolUse,
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
    if (handle.parentStreamId === handle.childStreamId) {
      throw new Error(
        `Execution '${executionId}' was detached from its orchestrator and now runs top-level. Its results can no longer be delivered back to this session — start a new delegation instead.`,
      );
    }
    const callerStreamId = getRunContextStreamId(parentContext);
    if (callerStreamId && handle.parentStreamId !== callerStreamId) {
      throw new Error(
        `Execution '${executionId}' belongs to a different orchestrator session. Its results would be delivered there, not here — start a new delegation instead.`,
      );
    }

    const framedInstruction = formatFollowUpInstruction(instruction);
    const result = await sendFollowUp(handle.childStreamId, framedInstruction);

    // Dispatch the wake without awaiting it: waking a WAITING subagent resumes
    // its run all the way to the next WAITING/terminal boundary, which can be
    // an entire child turn. This tool call only hands the follow-up off — the
    // result (or the wake's own failure) arrives asynchronously via the
    // follow-up queue, same as the original delegation's async-arrival
    // contract. Awaiting it here would stall this tool call, and the parent
    // orchestrator's whole turn with it, for as long as the child keeps
    // running (see #7289).
    //
    // A live child-run loop for this stream is already blocked in
    // `queue.waitAndDrainAll` on the same `FollowUpQueue` instance
    // `sendFollowUp` just enqueued into — the enqueue alone resolves that
    // wait (see `isChildRunLoopActive`), so an additional wake here would
    // race a second, competing resume through the generic host-level
    // restart-recovery path against the loop's own in-flight continuation.
    // Only genuinely wake when no loop is listening — a restarted process,
    // where the persisted stream is WAITING but nothing in this process is
    // watching its queue.
    if (!isChildRunLoopActive(handle.childStreamId)) {
      // A wake failure (thrown, or a resolved 'queued_resume_failed'/
      // 'dropped' outcome) means the child will never actually resume and
      // deliver a result — the orchestrator would otherwise see this tool
      // call return a normal "queued" success and then silently never hear
      // back. Deliver a terminal error to the parent on that failure, same
      // as the deleted NativeSubagentStrategy.wakeQueuedFollowUp used to.
      wakeQueuedFollowUpStream(handle.childStreamId, result, undefined, session)
        .then((wakeResult) => {
          if (
            wakeResult.kind === 'queued_resume_failed' ||
            wakeResult.kind === 'dropped'
          ) {
            return deliverResumeWakeFailure(
              handle,
              session,
              executionId,
              new Error(
                `Resume wake failed (${wakeResult.kind}): the subagent's follow-up could not be delivered to a resumed run.`,
              ),
            );
          }
        })
        .catch((err: unknown) =>
          deliverResumeWakeFailure(handle, session, executionId, err),
        );
    }

    switch (result.status) {
      case 'sent':
        return {
          status: 'executed',
          summary: `Follow-up sent to '${handle.agentName}'`,
          output: [
            `Follow-up instruction sent to '${handle.agentName}'. The subagent will process it and deliver a new result automatically.`,
            `Execution ID: ${executionId}`,
          ].join('\n'),
        };
      case 'queued':
        return {
          status: 'executed',
          summary: `Follow-up queued for '${handle.agentName}'`,
          output: [
            `Follow-up instruction queued for '${handle.agentName}' (${result.reason}). The subagent will process it and deliver a new result automatically.`,
            `Execution ID: ${executionId}`,
          ].join('\n'),
        };
      case 'no_session':
        throw new Error(
          `No active session for '${handle.agentName}' (stream status: ${result.streamStatus ?? 'unknown'}). The subagent may have stopped or its session expired.`,
        );
    }
  }
}
