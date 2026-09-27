/**
 * Tools for delegating agent runs from tool-use agents.
 * - delegate_workflow: For workflow agents (structured file I/O, fixed-round full-document rewrite)
 * - delegate_agent: For tool-use agents (follow-ups go through `executions send`)
 *
 * Interactive subagents execute asynchronously — result delivered via follow-up
 * queue. One-shot/headless parent runs execute subagents in-band because there
 * is no later interactive follow-up turn to consume async delivery.
 */

// Third-party imports
import { Effect, SynchronizedRef } from 'effect';
import { z } from 'zod';

// Local imports
import { ToolCall } from '@agent/runtime/ToolCall';
import type { ToolServices } from '@agent/runtime/ToolServices';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  extractionShorthandToolConfig,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
} from '@shared/schemas';
import type { ToolResult } from '@shared/schemas';
import { defineTool } from '@tools/core/define';
import { ensureError } from '@utils/errors/errorMessage';

// Local file imports
import { selectAvailableDelegationModel } from './delegationAvailability';
import {
  proposeAndExecute,
  requireDelegationParent,
  requireVisibleAgent,
} from './proposalFlow';
import {
  assertWorkflowFilesExist,
  memoriesField,
  rejectUnusableWorkingDirectory,
  workingDirectoryField,
  withToolUseSubagentHandoffInstruction,
  rejectOversizedBibAttachments,
  WorkflowAgentInputSchema,
  type WorkflowAgentInput,
} from './inputFields';

// ============================================================================
// delegate_workflow tool - for document processing agents
// ============================================================================

/** Tool for delegating tasks to workflow agents (document processing). */
function executeWorkflowAgentTool(
  input: WorkflowAgentInput,
): Effect.Effect<ToolResult, Error, ToolServices> {
  return Effect.gen(function* () {
    const call = yield* requireDelegationParent(
      'delegate_workflow',
      yield* ToolCall,
    );
    const agent = yield* requireVisibleAgent(
      call.roots,
      'workflow',
      input.agent,
      call.run.delegationAgentScope ?? undefined,
    );

    const model = yield* selectAvailableDelegationModel({
      requestedModel: input.model,
      parentModel: (yield* SynchronizedRef.get(call.run.model)).modelId,
      settings: call.roots,
    });

    yield* assertWorkflowFilesExist(call.roots.workspace, [
      { label: 'Input file', files: input.inputFiles },
      { label: 'Context file', files: input.contextFiles },
      { label: 'Media file', files: input.mediaFiles },
    ]).pipe(Effect.mapError(ensureError));

    const oversizedBibRejection = yield* rejectOversizedBibAttachments(
      call.roots.workspace,
      input.contextFiles,
    ).pipe(Effect.mapError(ensureError));
    if (oversizedBibRejection) return oversizedBibRejection;

    // Extraction flags map to toolConfig, flowing through the proposal UI and
    // into MediaExtractionNode → LatexMediaManager at runtime.
    const proposal = WorkflowAgentProposalSchema.parse({
      agentCategory: AgentCategory.Workflow,
      agent: agent.name,
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

    return yield* proposeAndExecute(call, proposal);
  });
}

export const WorkflowAgentTool = defineTool({
  name: 'delegate_workflow',
  availabilityCategory: 'workflow',
  requiresApproval: true,
  // A synchronous delegation (headless) runs for the child's whole run: its
  // card opens when the attempt is admitted, not only at settlement. An
  // asynchronous one settles at once, so its card closes right after opening.
  slow: true,
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
  execute: executeWorkflowAgentTool,
});

// ============================================================================
// delegate_agent tool - for interactive assistants
// ============================================================================

/** Schema for delegate_agent tool (tool-use agents). */
const DelegateAgentInputSchema = z.strictObject({
  agent: z.string().describe('Name of the tool-use agent to delegate to.'),
  model: z
    .string()
    .nullish()
    .describe(
      'Model short name from the Available models line. Omit unless the user explicitly requested a model; defaults to the current model when available.',
    ),
  instruction: z
    .string()
    .describe(
      'Plain prose instruction for the agent. Include file paths naturally and copy every relevant parent constraint into this field: tool/network/file/approval limits, output format, and scope. The subagent does not automatically inherit the parent conversation or hidden constraints.',
    ),
  memories: memoriesField,
  working_directory: workingDirectoryField,
});

type DelegateAgentInput = z.infer<typeof DelegateAgentInputSchema>;

/** Tool for delegating tasks to tool-use agents (interactive assistants). */
function executeDelegateAgentTool(
  input: DelegateAgentInput,
): Effect.Effect<ToolResult, Error, ToolServices> {
  return Effect.gen(function* () {
    const call = yield* requireDelegationParent(
      'delegate_agent',
      yield* ToolCall,
    );
    // The `working_directory` gate, over this call's project: the schema
    // parses the path, the session it runs on says whether worktrees are
    // enabled for it, and the path must be an existing directory.
    const unusable = yield* rejectUnusableWorkingDirectory(
      call.roots,
      input.working_directory ?? undefined,
    );
    if (unusable) return unusable;
    const agent = yield* requireVisibleAgent(
      call.roots,
      'toolUse',
      input.agent,
      call.run.delegationAgentScope ?? undefined,
    );

    const model = yield* selectAvailableDelegationModel({
      requestedModel: input.model,
      parentModel: (yield* SynchronizedRef.get(call.run.model)).modelId,
      settings: call.roots,
    });
    const rootUserInstruction = call.userInstruction;

    // Construct tool-use proposal (no file fields)
    const proposal = ToolUseAgentProposalSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: agent.name,
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

    return yield* proposeAndExecute(call, proposal);
  });
}

export const DelegateAgentTool = defineTool({
  name: 'delegate_agent',
  availabilityCategory: 'toolUse',
  requiresApproval: true,
  // Card at admission, as for `delegate_workflow` above.
  slow: true,
  // Static base text; the "Available agents:", "Available models:", and "Git
  // worktree support:" lines are resolved per run at the resolveAgentTools
  // boundary.
  description: `Delegate a task to a new tool-use agent with its own tools (file reading, editing, search, bash). Tool-use agents can create entire documents, make targeted edits, perform research, or run multi-step investigations.

To send a subagent follow-up instructions, use the executions tool: action "send" on /executions/{id}. The subagent keeps its full history, and its next result arrives like the first.

Delegations run asynchronously. When subtasks are independent, launch them all in one turn and continue your own work. Each result arrives automatically as a follow-up message.

Available agents: loaded from the active roster at runtime.

Agent selection: choose the most specific agent whose description matches the task.

Available models: loaded from the active credentials at runtime.
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Git worktree support: resolved from the active workspace at runtime.`,
  schema: DelegateAgentInputSchema,
  execute: executeDelegateAgentTool,
});
