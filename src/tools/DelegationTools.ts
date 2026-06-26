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
import { getVisibleAgents } from '@agent/index/agentRegistry';
import { currentSession } from '@agent/runtime/SessionHandle';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { tryUseRunContext, type RunContext } from '@agent/runtime/RunContext';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';

// Local imports - tools
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
  type StreamTabId,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas/toolResult';
import { formatFollowUpInstruction } from '@tools/subagentResults';
import { subagentDeliveryRegistry } from '@tools/subagentDeliveryState';
import { isWorktreeSupportEnabled } from '@tools/worktreeConfig';
import { defineTool } from '@tools/core/define';

// Local imports - delegation
import {
  formatAgentList,
  proposeAndExecute,
  requireVisibleAgent,
  resolveAvailableDelegationModel,
} from './delegation/proposalFlow';
import { depthGateError } from './delegation/subagentExecution';
import {
  memoriesField,
  workingDirectoryField,
  withToolUseSubagentHandoffInstruction,
  rejectOversizedBibAttachments,
} from './delegation/inputFields';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';
import { isNonEmptyString } from '@utils/core/stringCore';

export { rejectOversizedBibAttachments } from './delegation/inputFields';

/** Get required context fields, throwing if unavailable. */
function getRequiredContext(): RunContext & {
  streamId: StreamTabId;
} {
  const ctx = tryUseRunContext();
  if (!ctx?.streamId) {
    throw new Error(
      'Tool context unavailable. Cannot create proposal without active stream.',
    );
  }
  return ctx as RunContext & { streamId: StreamTabId };
}

// ============================================================================
// delegate_workflow tool - for document processing agents
// ============================================================================

/** Schema for delegate_workflow tool (document processing). */
const WorkflowAgentInputSchema = z.strictObject({
  agent: z.string().describe('Name of the workflow agent to execute'),
  model: z
    .string()
    .nullish()
    .describe(
      'Model short name from the Available models line. Omit unless the user explicitly requested a model; defaults to the current model when available.',
    ),
  instruction: z
    .string()
    .describe(
      'What the agent should do, in plain prose. If you attach context or media files, name each one and say what role it plays — e.g., "preamble.tex defines the math macros; refs.bib is the bibliography to cite from; figure.png shows the panel layout to match". The sub-agent has no other signal for why each file was attached.',
    ),
  inputFiles: z
    .array(z.string())
    .min(1)
    .describe(
      'Files the agent rewrites. List every file you want it to touch. The agent emits one revised <document> per entry.',
    ),
  contextFiles: z
    .array(z.string())
    .prefault([])
    .describe(
      'Read-only context the agent should see but not modify: guidance, examples, related papers, bibliographies (.bib), style/macro definitions (.sty/.cls). Explain each one in the instruction.',
    ),
  mediaFiles: z
    .array(z.string())
    .prefault([])
    .describe('Images, figures, PDFs, or audio files the agent should view.'),
  extractFigures: z
    .boolean()
    .nullish()
    .describe(
      'When true, automatically extracts figures referenced by the input LaTeX file(s) (via \\includegraphics, \\begin{overpic}) and attaches them as media files. Merges with any explicitly provided mediaFile/mediaFiles.',
    ),
  extractTikz: z
    .boolean()
    .nullish()
    .describe(
      'When true, extracts TikZ figures from the input LaTeX file(s), compiles them into standalone PDFs, and attaches them as media files.',
    ),
  outputFiles: z
    .array(z.string())
    .prefault([])
    .describe(
      'Output file paths. Must be a subset of input files—never create new files or change format. Leave empty for default suffix-based outputs.',
    ),
  memories: memoriesField,
});

export type WorkflowAgentInput = z.infer<typeof WorkflowAgentInputSchema>;

/** Tool for delegating tasks to workflow agents (document processing). */
export class WorkflowAgentTool extends defineTool({
  name: 'delegate_workflow',
  description:
    () => `Delegate to a workflow agent. The agent rewrites every file you list in inputFiles, emitting one revised <document> per input. Use for whole-document operations: proofreading, polishing, applying reviews, adding derivations, merging revisions. For interactive tool use or selective edits, use delegate_agent instead.

Available agents:
${formatAgentList(getVisibleAgents('workflow'))}

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
    const agentName = requireVisibleAgent('workflow', input.agent).name;
    const ctx = getRequiredContext();

    const model = await resolveAvailableDelegationModel({
      requestedModel: input.model,
      parentModel: ctx.model,
    });

    // Validate all file paths exist (parallel for performance)
    const toValidate = (
      arr: string[],
      label: string,
    ): { path: string; label: string }[] =>
      arr.filter(isNonEmptyString).map((path) => ({ path, label }));

    const filesToValidate = [
      ...toValidate(input.inputFiles, 'Input file'),
      ...toValidate(input.contextFiles, 'Context file'),
      ...toValidate(input.mediaFiles, 'Media file'),
    ];

    const validationResults = await Promise.all(
      filesToValidate.map(async ({ path, label }) => ({
        path,
        label,
        exists: await WorkspaceFS.exists(path),
      })),
    );

    const missing = validationResults.find((r) => !r.exists);
    if (missing) {
      throw new Error(`${missing.label} not found: ${missing.path}`);
    }

    const oversizedBibRejection = await rejectOversizedBibAttachments(input);
    if (oversizedBibRejection) return oversizedBibRejection;

    // Extraction flags map to toolConfig, flowing through the proposal UI and
    // into MediaExtractionNode → LatexMediaManager at runtime.
    const proposal = WorkflowAgentProposalSchema.parse({
      agentCategory: AgentCategory.Workflow,
      agent: agentName,
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

    return proposeAndExecute(proposal, agentName, ctx.streamId);
  }
}

// ============================================================================
// delegate_agent tool - for interactive assistants
// ============================================================================

/** Schema for delegate_agent tool (tool-use agents). */
const DelegateAgentInputSchema = z.strictObject({
  agent: z
    .string()
    .nullish()
    .describe(
      'Name of the tool-use agent to delegate to. Required for new delegations, ignored when resuming via execution_id.',
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
});

export type DelegateAgentInput = z.infer<typeof DelegateAgentInputSchema>;

/** Tool for delegating tasks to tool-use agents (interactive assistants). */
export class DelegateAgentTool extends defineTool({
  name: 'delegate_agent',
  description:
    () => `Delegate a task to a tool-use agent, or queue follow-up instructions for a tool-use subagent.

**New delegation** (no execution_id): Launches a new tool-use agent with its own tools (file reading, editing, search, bash). Tool-use agents are versatile—they can create entire documents, make targeted edits, perform research, or run multi-step investigations.

**Resume** (with execution_id): Sends follow-up instructions to a WAITING or still-running subagent. If the subagent is busy, the instruction is queued for its next turn. The subagent keeps its full history. Result arrives asynchronously like the original delegation.

When a subagent result is delivered, preserve its stated evidence, tool names, and caveats accurately; do not substitute or invent methods while summarizing it for the user.

Available agents:
${formatAgentList(getVisibleAgents('toolUse'))}

Agent selection: choose the most specific agent whose description matches the task. Specialized agents have domain-specific tools and focused prompts that produce better results for matching tasks. When using a general-purpose agent, state why the work does not map cleanly to a listed specialist.

Available models: loaded from the active API mode at runtime.
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Example (new, specialized): agent=research, instruction="Derive the asymptotic expansion of the partition function in appendix_A.tex using saddle-point methods. Verify with Wolfram."
Example (new, targeted LaTeX repair): agent=latexFixer, instruction="Fix the unresolved citation commands on slides 3 and 7 in slides/talk.tex using refs.bib."
Example (resume): execution_id=exec_abc123, instruction="Also fix the bibliography slide formatting."

Git worktree support: ${
      isWorktreeSupportEnabled()
        ? 'ENABLED. Pass `working_directory` (absolute path) to run a subagent rooted in a git worktree; every tool call in the subagent resolves paths against that directory. The subagent reports its working directory back in its delivery result.'
        : 'DISABLED in this workspace. Do not pass `working_directory` — it will be rejected at schema validation. Ask the user to enable "Allow agents to work in git worktrees" on the Multi-Agent settings tab if worktree operation is needed.'
    }`,
  schema: DelegateAgentInputSchema,
}) {
  protected async execute(input: DelegateAgentInput): Promise<ToolResult> {
    // Resume path: execution_id is set
    if (input.execution_id) {
      return this.resumeAgent(input.execution_id, input.instruction);
    }

    // Delegate path: agent is required
    if (!input.agent) {
      throw new Error(
        `'agent' is required when starting a new delegation. Provide an agent name, or set 'execution_id' to resume an existing subagent.`,
      );
    }

    const agentName = requireVisibleAgent('toolUse', input.agent).name;

    const ctx = getRequiredContext();

    const model = await resolveAvailableDelegationModel({
      requestedModel: input.model,
      parentModel: ctx.model,
    });

    // Construct tool-use proposal (no file fields)
    const proposal = ToolUseAgentProposalSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: agentName,
      model,
      instruction: withToolUseSubagentHandoffInstruction(input.instruction),
      memories: input.memories,
      workingDirectory: input.working_directory,
    } satisfies ToolUseAgentProposal);

    return proposeAndExecute(proposal, agentName, ctx.streamId);
  }

  /** Queue follow-up instructions for a tool-use subagent. */
  private async resumeAgent(
    executionId: string,
    instruction: string,
  ): Promise<ToolResult> {
    const parentContext = tryUseRunContext();
    const parentDelegationDepth = parentContext?.delegationDepth ?? 0;
    const gated = depthGateError(parentDelegationDepth);
    if (gated) return gated;

    const handle = currentSession().executions.getHandle(executionId);
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
    const callerStreamId = parentContext?.streamId;
    if (callerStreamId && handle.parentStreamId !== callerStreamId) {
      throw new Error(
        `Execution '${executionId}' belongs to a different orchestrator session. Its results would be delivered there, not here — start a new delegation instead.`,
      );
    }

    const deliveryState = subagentDeliveryRegistry.getActive(executionId);
    if (!deliveryState) {
      throw new Error(
        `Execution '${executionId}' is no longer tracked for delivery. It may have already completed.`,
      );
    }

    const framedInstruction = formatFollowUpInstruction(instruction);
    const result = await sendFollowUp(handle.childStreamId, framedInstruction);

    switch (result.status) {
      case 'sent':
        deliveryState.markPending();
        return {
          summary: `Follow-up sent to '${handle.agentName}'`,
          output: [
            `Follow-up instruction sent to '${handle.agentName}'. The subagent will process it and deliver a new result automatically.`,
            `Execution ID: ${executionId}`,
          ].join('\n'),
        };
      case 'queued':
        deliveryState.markPending();
        return {
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
