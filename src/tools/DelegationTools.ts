/**
 * Tools for delegating agent executions from tool-use agents.
 * Three separate tools for clean separation of concerns:
 * - delegate_workflow: For workflow agents (structured file I/O, fixed-round full-document rewrite)
 * - delegate_agent: For tool-use agents (interactive, versatile — edits, creation, research)
 * - resume_agent: Resume a WAITING tool-use subagent with follow-up instructions
 *
 * All subagents execute asynchronously — result delivered via follow-up queue.
 */

// Third-party imports
import { randomUUID } from 'crypto';
import * as path from 'path';
import { z } from 'zod';

// Local imports - agent
import { getExecutionStore, registerExecution } from '@agent/storage';
import { getAgent, getVisibleAgents } from '@agent/index/agentRegistry';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { executeAgent } from '@agent/runtime/executeAgent';
import { proposalCoordinator } from '@agent/runtime/AgentProposalCoordinator';
import {
  getHandle,
  AgentExecutionHandle,
} from '@agent/runtime/executionRegistry';
import {
  getCurrentToolFileInteractionContext,
  type ToolFileInteractionContext,
} from '@agent/toolUse/ToolFileInteractionContext';
import { sendFollowUp } from '@agent/toolUse/ToolUseFollowUp';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';

// Local imports - latex
import {
  extractBibliographyContext,
  loadBibliographyEntries,
  summarizeBibliographyEntries,
} from '@latex/extractBibliography';
import { extractFigurePathsFromLatex } from '@latex/extractFigure';
import { tikzPictureManager } from '@latex/TikzPictureManager';

// Local imports - logger
import * as logger from '@logger/logUtils';

// Local imports - model
import {
  getVisibleModels,
  resolveVisibleModel,
} from '@model/computeModelOptions';
import {
  AGENT_CATEGORY,
  WorkflowAgentProposalSchema,
  ToolUseAgentProposalSchema,
  type WorkflowAgentProposal,
  type ToolUseAgentProposal,
  type StreamTabId,
  type SubagentProgressUpdate,
} from '@shared/schemas';

// Local imports - tools
import type { ToolResult } from '@tools/result';
import {
  isSuperYoloFeatureEnabled,
  isProposalBypassedForStream,
  isApprovalBypassedForStream,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import {
  computeAndWriteWorkflowDiffs,
  formatSubagentDelivery,
  formatSubagentError,
  formatSubagentProgress,
  formatFollowUpInstruction,
} from '@tools/subagentResults';
import { defineTool } from '@tools/core/define';

// Local imports - memory
import { displayToStoragePath } from '@tools/memory/memoryUtils';

// Local imports - utils
import { WorkspaceFS, pathToLocation } from '@utils/files';
import { generateExecutionId } from '@utils/core/executionId';

// ============================================================================
// Shared utilities
// ============================================================================

const LOG_CHANNEL = 'DelegationTools';
logger.initialize(LOG_CHANNEL);

// ============================================================================
// Subagent delivery state tracking
// ============================================================================

/**
 * Per-execution delivery gate for subagent result routing.
 *
 * `hasDelivered` prevents duplicate delivery of the same result via both
 * `onBeforeWaiting` and `onCompleted`. When `resume_agent` confirms a
 * follow-up was accepted, it resets `hasDelivered` so the next cycle's
 * `onBeforeWaiting` delivers the new result back to the orchestrator.
 */
interface SubagentDeliveryState {
  hasDelivered: boolean;
}

const activeSubagentDelivery = new Map<string, SubagentDeliveryState>();

/**
 * Shared Zod field for the `memories` parameter on delegation tools.
 * Validates that all paths are within /memories using displayToStoragePath
 * (prefix + traversal checks). Existence is NOT checked — getAttachedMemories
 * handles read failures gracefully, avoiding a TOCTOU race.
 */
const memoriesField = z
  .array(z.string())
  .prefault([])
  .describe(
    'Memory file paths to attach (e.g. /memories/conventions.md). Content is injected into the agent prompt as read-only context. Use for project conventions, style guides, or accumulated knowledge the agent should follow.',
  )
  .superRefine((memories, ctx) => {
    for (let i = 0; i < memories.length; i++) {
      try {
        displayToStoragePath(memories[i]);
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message:
            e instanceof Error
              ? e.message
              : `Invalid memory path: ${memories[i]}`,
        });
      }
    }
  });

/** Get required context fields, throwing if unavailable. */
function getRequiredContext(): ToolFileInteractionContext & {
  streamId: StreamTabId;
} {
  const ctx = getCurrentToolFileInteractionContext();
  if (!ctx?.streamId) {
    throw new Error(
      'Tool context unavailable. Cannot create proposal without active stream.',
    );
  }
  return ctx as ToolFileInteractionContext & { streamId: StreamTabId };
}

/** Build config payload from a proposal. */
function toConfigPayload(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): AgentConfigPayload {
  return {
    ...proposal,
    agentCategory:
      proposal.agentCategory === AGENT_CATEGORY.TOOL_USE
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow,
  };
}

/** Metadata about how the delegation was approved, included in the tool result. */
interface ApprovalMeta {
  autoApproved: boolean;
  modelOverride?: string;
  requestedModel?: string;
}

/**
 * Execute a subagent asynchronously.
 * Pre-generates executionId so all IDs (tool return, XML delivery, error)
 * are consistent and usable with the executions tool.
 *
 * Result is delivered via FollowUpQueue. For tool-use subagents, the result
 * is delivered early via onBeforeWaiting (before the subagent enters WAITING),
 * so the orchestrator gets the response without waiting for flow exit.
 * For workflow subagents, delivery happens when the promise resolves.
 */
async function executeSubagent(
  configPayload: AgentConfigPayload,
  agentName: string,
  orchestratorStreamId: StreamTabId,
  options?: { enableYoloOnChild?: boolean; approvalMeta?: ApprovalMeta },
): Promise<ToolResult> {
  const executionId = generateExecutionId();

  const parentExecutionId = getCurrentToolFileInteractionContext()?.executionId;
  const syntheticConfig = AgentConfigSchema.parse(configPayload);
  await registerExecution(
    executionId,
    syntheticConfig,
    agentName,
    parentExecutionId,
  );

  // Track delivery state in the module-level map so resume_agent can reset it.
  // The flag prevents duplicate delivery of the same result via both
  // onBeforeWaiting and onCompleted. When resume_agent resets the flag,
  // the next onBeforeWaiting will deliver the resumed cycle's result.
  const deliveryState: SubagentDeliveryState = { hasDelivered: false };
  activeSubagentDelivery.set(executionId, deliveryState);
  let childStreamId: StreamTabId | undefined;

  function onProgress(update: SubagentProgressUpdate): void {
    if (deliveryState.hasDelivered) return;
    const msg = formatSubagentProgress(executionId, agentName, update);
    ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
  }

  const promise = executeAgent(configPayload, executionId, {
    isSubagent: true,
    enforceCategory: true,
    parentStreamId: orchestratorStreamId,
    onStreamResolved: (resolvedStreamId) => {
      childStreamId = resolvedStreamId;
      if (options?.enableYoloOnChild) {
        // Silent: fires before stream activation so the UI notification would
        // be dropped. The subsequent SYNC_STREAM_CONTENT reads from the map.
        setToolEditApprovalSessionBypass(resolvedStreamId, true, {
          silent: true,
        });
      }
    },
    onProgress,
    onBeforeWaiting: async (lastResponse) => {
      if (deliveryState.hasDelivered || !childStreamId) return;
      const msg = formatSubagentDelivery(agentName, {
        category: 'toolUse' as const,
        status: 'stopped' as const,
        lastResponse,
        executionId,
        streamId: childStreamId,
      });
      // Best-effort persist — must never block delivery or abort the subagent.
      try {
        await getExecutionStore(executionId).writeReport(msg);
      } catch {
        /* storage failure is non-fatal */
      }
      // Mark delivered and enqueue only after the write attempt so that
      // onCompleted can still act as a fallback if we somehow never reach here.
      deliveryState.hasDelivered = true;
      ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
    },
    onCompleted: async (result) => {
      if (deliveryState.hasDelivered) return;
      deliveryState.hasDelivered = true;

      // For workflow results, compute diffs and write them as files to the
      // execution's run directory. The delivery references diff file paths
      // so the orchestrator can read them on demand via /executions/{id}/files/.
      let diffInfos:
        | Awaited<ReturnType<typeof computeAndWriteWorkflowDiffs>>
        | undefined;
      if (result.category === 'workflow' && result.outputs.length > 0) {
        try {
          diffInfos = await computeAndWriteWorkflowDiffs(
            executionId,
            result.outputs,
          );
        } catch {
          // Diff computation failure is non-fatal — deliver without diffs.
        }
      }

      const msg = formatSubagentDelivery(agentName, result, diffInfos);
      void getExecutionStore(executionId).writeReport(msg);
      ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
    },
  });
  promise
    .catch((err: unknown) => {
      const msg = formatSubagentError(executionId, agentName, err);
      void getExecutionStore(executionId).writeReport(msg);
      ToolUseFollowUpQueue.enqueue(orchestratorStreamId, msg);
    })
    .finally(() => {
      activeSubagentDelivery.delete(executionId);
    });
  const isToolUse = configPayload.agentCategory === AgentCategory.ToolUse;
  const meta = options?.approvalMeta;
  const metaLines: string[] = [];
  if (meta) {
    const modelInfo = meta.modelOverride
      ? `Model: ${meta.modelOverride} (overridden from ${meta.requestedModel ?? 'default'})`
      : `Model: ${configPayload.model}`;
    metaLines.push(
      `Approval: ${meta.autoApproved ? 'auto-approved' : 'user-approved'}. ${modelInfo}.`,
    );
  }
  return {
    summary: `Launched '${agentName}' (async)`,
    output: [
      `Subagent '${agentName}' launched. Result will be delivered automatically as a follow-up message when complete.`,
      `Execution ID: ${executionId}`,
      ...metaLines,
      `To check intermediate progress: executions tool with path=/executions/${executionId} and action=wait (waits for next status change).`,
      ...(isToolUse
        ? [
            `To send follow-up instructions after delivery: use resume_agent with this execution ID.`,
          ]
        : []),
    ].join('\n'),
  };
}

/** Format an agent list for tool descriptions. */
function formatAgentList(
  agents: { name: string; description?: string; tools?: string[] }[],
): string {
  return agents
    .map((agent) => {
      const desc = agent.description || 'No description';
      const toolsSuffix = agent.tools?.length
        ? `\n  Tools: ${agent.tools.join(', ')}`
        : '';
      return `- ${agent.name}: ${desc}${toolsSuffix}`;
    })
    .join('\n');
}

/** Build a concise summary of proposal parameters for rejection echo. */
function summarizeProposal(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): string {
  const parts = [`Agent: ${proposal.agent}`, `Model: ${proposal.model}`];
  if ('inputFile' in proposal && proposal.inputFile) {
    parts.push(`File: ${proposal.inputFile}`);
  }
  if (proposal.memories.length > 0) {
    parts.push(`Memories: ${proposal.memories.join(', ')}`);
  }
  const instrPreview =
    proposal.instruction.length > 120
      ? `${proposal.instruction.slice(0, 117)}...`
      : proposal.instruction;
  parts.push(`Instruction: "${instrPreview}"`);
  return parts.join(', ');
}

/** Convert proposal result to ToolResult. Returns null if approved. */
function proposalResultToToolResult(
  result: Awaited<ReturnType<typeof proposalCoordinator.waitForProposal>>,
  agentName: string,
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
): ToolResult | null {
  const echo = summarizeProposal(proposal);

  switch (result.action) {
    case 'reject': {
      const feedback = result.feedback?.trim();
      const feedbackLine = feedback
        ? `\nUser feedback: ${feedback}`
        : '\nNo feedback provided. Consider asking the user for guidance.';
      return {
        summary: `User rejected delegation to '${agentName}'`,
        output: `Delegation to '${agentName}' was rejected.\nYour delegation was: ${echo}${feedbackLine}`,
        isError: true,
      };
    }
    case 'timeout':
      return {
        summary: `Delegation to '${agentName}' timed out`,
        output: `Delegation to '${agentName}' timed out waiting for user approval.\nYour delegation was: ${echo}`,
        isError: true,
      };
    case 'setup':
      return {
        summary: `User opened '${agentName}' for editing`,
        output: `Delegation opened for editing. The user will run it manually when ready.\nYour delegation was: ${echo}`,
      };
    case 'approve':
      return null;
  }
}

/**
 * Shared proposal-or-bypass flow used by both delegate_workflow and delegate_agent.
 *
 * If Super YOLO is active for this stream, skips the proposal and launches immediately.
 * Otherwise, waits for user approval via the proposal coordinator.
 */
async function proposeAndExecute(
  proposal: WorkflowAgentProposal | ToolUseAgentProposal,
  agentName: string,
  streamId: StreamTabId,
): Promise<ToolResult> {
  if (isSuperYoloFeatureEnabled() && isProposalBypassedForStream(streamId)) {
    return executeSubagent(toConfigPayload(proposal), agentName, streamId, {
      enableYoloOnChild: true,
      approvalMeta: { autoApproved: true },
    });
  }

  const proposalId = randomUUID();

  const result = await proposalCoordinator.waitForProposal(streamId, {
    proposalId,
    proposal,
  });

  const nonApproveResult = proposalResultToToolResult(
    result,
    agentName,
    proposal,
  );
  if (nonApproveResult) return nonApproveResult;

  // At this point result.action === 'approve' (all other cases returned above)
  const modelOverridden =
    result.action === 'approve' && result.model ? result.model : undefined;
  const effective = modelOverridden
    ? { ...proposal, model: modelOverridden }
    : proposal;
  const approvalMeta: ApprovalMeta = {
    autoApproved: false,
    ...(modelOverridden && {
      modelOverride: modelOverridden,
      requestedModel: proposal.model,
    }),
  };
  return executeSubagent(toConfigPayload(effective), agentName, streamId, {
    enableYoloOnChild: isApprovalBypassedForStream(streamId),
    approvalMeta,
  });
}

// ============================================================================
// delegate_workflow tool - for document processing agents
// ============================================================================

/** Schema for delegate_workflow tool (document processing). */
const WorkflowAgentInputSchema = z.object({
  agent: z.string().describe('Name of the workflow agent to execute'),
  model: z
    .string()
    .optional()
    .describe(
      'Model short name (e.g., opus46T, sonnet46T, gpt54, gemini31p). Defaults to the current model if omitted.',
    ),
  instruction: z.string().describe('Plain prose instruction for the agent'),
  inputFile: z.string().describe('Primary input file to process (required)'),
  inputFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional input files'),
  referenceFile: z
    .string()
    .nullable()
    .prefault(null)
    .describe(
      'Reference file providing guidance or examples (not modified). Do not put .bib files here.',
    ),
  referenceFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional reference files'),
  auxiliaryFile: z
    .string()
    .nullable()
    .prefault(null)
    .describe(
      'Auxiliary file for supplementary content like bibliographies (.bib files).',
    ),
  auxiliaryFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional auxiliary files'),
  mediaFile: z
    .string()
    .nullable()
    .prefault(null)
    .describe('Media file for images/figures'),
  mediaFiles: z
    .array(z.string())
    .prefault([])
    .describe('Additional media files'),
  extractFigures: z
    .boolean()
    .prefault(false)
    .describe(
      'When true, automatically extracts figures referenced by the input LaTeX file(s) (via \\includegraphics, \\begin{overpic}) and attaches them as media files. Merges with any explicitly provided mediaFile/mediaFiles.',
    ),
  extractTikz: z
    .boolean()
    .prefault(false)
    .describe(
      'When true, extracts TikZ figures from the input LaTeX file(s), compiles them into standalone PDFs, and attaches them as media files.',
    ),
  extractBibliography: z
    .boolean()
    .prefault(false)
    .describe(
      'When true, resolves cited BibTeX entries from .bib files referenced by the input LaTeX file(s) and appends them to the instruction. Only cited entries are included (capped at 50) to avoid bloating the prompt with large bibliography files.',
    ),
  outputFiles: z
    .array(z.string())
    .prefault([])
    .describe(
      'Output file paths. Must be a subset of input files—never create new files or change format. Leave empty for default suffix-based outputs.',
    ),
  useMultipleOutputs: z
    .boolean()
    .prefault(false)
    .describe(
      'Set true when outputFiles has multiple entries. Enables multi-file extraction from agent response.',
    ),
  memories: memoriesField,
});

export type WorkflowAgentInput = z.infer<typeof WorkflowAgentInputSchema>;

/** Tool for delegating tasks to workflow agents (document processing). */
export class WorkflowAgentTool extends defineTool({
  name: 'delegate_workflow',
  description:
    () => `Delegate a task to a workflow agent. Workflow agents receive structured file parameters (input, reference, auxiliary, media, output) and rewrite the entire input file from start to finish in fixed rounds. Best for uniform whole-document operations: grammar correction, style polishing, figure generation, document merging. NOT suitable for tasks requiring interactive tool use, exploration, or selective edits—use delegate_agent for those.

Available agents:
${formatAgentList(getVisibleAgents('workflow'))}

Available models: ${getVisibleModels().join(', ')}
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Extraction attachments — automatically discover and attach assets from input LaTeX file(s):
- extractFigures=true: Extract \\includegraphics/\\begin{overpic} figures and attach as media files.
- extractTikz=true: Compile TikZ figures into standalone PDFs and attach as media files.
- extractBibliography=true: Resolve cited BibTeX entries and include them in the instruction.
All extraction options merge with explicitly provided files and are non-fatal on failure.

Example: agent=correct, inputFile=paper.tex, extractFigures=true, extractBibliography=true, instruction="This research paper proposes a new quantum error correction scheme. Please fix grammar errors, improve sentence clarity, and ensure consistent terminology throughout. Pay particular attention to the abstract and introduction where the key contributions are summarized."`,
  schema: WorkflowAgentInputSchema,
}) {
  protected async execute(input: WorkflowAgentInput): Promise<ToolResult> {
    // Validate agent exists and is a workflow agent
    const agentEntry = getAgent(input.agent);
    if (!agentEntry) {
      const available = getVisibleAgents('workflow')
        .map((a) => a.name)
        .join(', ');
      throw new Error(
        `Unknown workflow agent '${input.agent}'. Available: ${available}`,
      );
    }

    if (agentEntry.category !== AgentCategory.Workflow) {
      throw new Error(
        `'${input.agent}' is not a workflow agent. Use delegate_agent for tool-use agents.`,
      );
    }

    const ctx = getRequiredContext();

    // Resolve model: explicit input → parent model → first visible model
    const model = resolveVisibleModel(input.model ?? ctx.model ?? '');

    // Validate inputFile is provided
    if (!input.inputFile) {
      throw new Error('inputFile is required for workflow agents.');
    }

    // Validate all file paths exist (parallel for performance)
    const toValidate = (
      single: string | null | undefined,
      arr: string[],
      label: string,
    ): { path: string; label: string }[] =>
      [single, ...arr]
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((path) => ({ path, label }));

    const filesToValidate = [
      ...toValidate(input.inputFile, input.inputFiles, 'Input file'),
      ...toValidate(
        input.referenceFile,
        input.referenceFiles,
        'Reference file',
      ),
      ...toValidate(
        input.auxiliaryFile,
        input.auxiliaryFiles,
        'Auxiliary file',
      ),
      ...toValidate(input.mediaFile, input.mediaFiles, 'Media file'),
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

    // Collect effective file lists — extraction options may add entries
    const effectiveMediaFiles = [...input.mediaFiles];

    const allInputTexFiles = [input.inputFile, ...input.inputFiles].filter(
      (f) => f.toLowerCase().endsWith('.tex'),
    );

    // Extract figures from input file(s) when requested
    if (input.extractFigures) {
      const extractedPaths = new Set<string>();

      for (const inputFilePath of allInputTexFiles) {
        try {
          const location = pathToLocation(inputFilePath);
          const figurePaths =
            await extractFigurePathsFromLatex(location);
          const inputDir = path.dirname(inputFilePath);
          for (const figurePath of figurePaths) {
            extractedPaths.add(
              path.normalize(path.join(inputDir, figurePath)),
            );
          }
        } catch {
          logger.debug(
            LOG_CHANNEL,
            `Figure extraction skipped for ${inputFilePath}`,
          );
        }
      }

      const existingMedia = new Set(
        [input.mediaFile, ...effectiveMediaFiles].filter(Boolean),
      );
      for (const extracted of extractedPaths) {
        if (!existingMedia.has(extracted)) {
          effectiveMediaFiles.push(extracted);
        }
      }
    }

    // Extract and compile TikZ figures when requested
    if (input.extractTikz) {
      const existingMedia = new Set(
        [input.mediaFile, ...effectiveMediaFiles].filter(Boolean),
      );
      for (const inputFilePath of allInputTexFiles) {
        try {
          const location = pathToLocation(inputFilePath);
          const compiledPdfs = await tikzPictureManager.compile(location);
          for (const pdfLocation of compiledPdfs) {
            const pdfPath =
              pdfLocation.kind !== 'external'
                ? pdfLocation.relativePath
                : pdfLocation.absolutePath;
            if (!existingMedia.has(pdfPath)) {
              effectiveMediaFiles.push(pdfPath);
              existingMedia.add(pdfPath);
            }
          }
        } catch {
          logger.debug(
            LOG_CHANNEL,
            `TikZ extraction skipped for ${inputFilePath}`,
          );
        }
      }
    }

    // Extract cited bibliography entries when requested.
    // Instead of attaching raw .bib files (which can be very large),
    // we resolve only the cited entries and append them to the instruction.
    let bibEntriesSuffix = '';
    if (input.extractBibliography) {
      const allBibFiles = new Set<string>();
      const allCitationKeys = new Set<string>();

      for (const inputFilePath of allInputTexFiles) {
        try {
          const context = await extractBibliographyContext(inputFilePath);
          for (const bibFile of context.bibliographyFiles) {
            allBibFiles.add(bibFile);
          }
          for (const key of context.citationKeys) {
            allCitationKeys.add(key);
          }
        } catch {
          logger.debug(
            LOG_CHANNEL,
            `Bibliography extraction skipped for ${inputFilePath}`,
          );
        }
      }

      if (allBibFiles.size > 0 && allCitationKeys.size > 0) {
        try {
          const MAX_BIB_ENTRIES = 50;
          const { entries } = await loadBibliographyEntries(
            [...allBibFiles],
            [...allCitationKeys],
          );
          if (entries.size > 0) {
            const lines = summarizeBibliographyEntries(
              entries,
              MAX_BIB_ENTRIES,
            );
            bibEntriesSuffix = `\n\n<bibliography>\n${lines.join('\n')}\n</bibliography>`;
          }
        } catch {
          logger.debug(
            LOG_CHANNEL,
            'Bibliography entry loading failed',
          );
        }
      }
    }

    // Construct workflow proposal
    // Memory paths are already validated by memoriesField's .superRefine() at schema parse time.
    const proposal = WorkflowAgentProposalSchema.parse({
      agentCategory: AgentCategory.Workflow,
      agent: input.agent,
      model,
      instruction: input.instruction + bibEntriesSuffix,
      inputFile: input.inputFile,
      inputFiles: input.inputFiles,
      referenceFile: input.referenceFile,
      referenceFiles: input.referenceFiles,
      auxiliaryFile: input.auxiliaryFile,
      auxiliaryFiles: input.auxiliaryFiles,
      mediaFile: input.mediaFile,
      mediaFiles: effectiveMediaFiles,
      outputFiles: input.outputFiles,
      useMultipleOutputs: input.useMultipleOutputs,
      memories: input.memories,
    } satisfies WorkflowAgentProposal);

    return proposeAndExecute(proposal, input.agent, ctx.streamId);
  }
}

// ============================================================================
// delegate_agent tool - for interactive assistants
// ============================================================================

/** Schema for delegate_agent tool (tool-use agents). */
const DelegateAgentInputSchema = z.object({
  agent: z.string().describe('Name of the tool-use agent to delegate to'),
  model: z
    .string()
    .optional()
    .describe(
      'Model short name (e.g., opus46T, sonnet46T, gpt54, gemini31p). Defaults to the current model if omitted.',
    ),
  instruction: z
    .string()
    .describe('Plain prose instruction with file paths included naturally'),
  memories: memoriesField,
});

export type DelegateAgentInput = z.infer<typeof DelegateAgentInputSchema>;

/** Tool for delegating tasks to tool-use agents (interactive assistants). */
export class DelegateAgentTool extends defineTool({
  name: 'delegate_agent',
  description:
    () => `Delegate a task to a tool-use agent. The agent has its own tools (file reading, editing, search, bash) and works interactively. Tool-use agents are versatile—they can create entire documents (e.g., presentations, posters), make targeted edits, perform research, explore codebases, or run multi-step investigations. Choose the agent whose specialization matches the task.

Available agents:
${formatAgentList(getVisibleAgents('toolUse'))}

Available models: ${getVisibleModels().join(', ')}
Model selection: use the largest models for challenging tasks requiring deep reasoning; use cheaper long-context models for tedious but lengthy tasks; use cost-effective models for highly parallelizable routine work.

Example: agent=chat, instruction="The presentation at slides/talk.tex has incorrect citations on slides 3 and 7. Please read the file, fix the \\cite commands to reference the correct BibTeX keys from refs.bib, and ensure the bibliography slide is consistent."`,
  schema: DelegateAgentInputSchema,
}) {
  protected async execute(input: DelegateAgentInput): Promise<ToolResult> {
    // Validate agent exists and is a tool-use agent
    const agentEntry = getAgent(input.agent);
    if (!agentEntry) {
      const available = getVisibleAgents('toolUse')
        .map((a) => a.name)
        .join(', ');
      throw new Error(
        `Unknown tool-use agent '${input.agent}'. Available: ${available}`,
      );
    }

    if (agentEntry.category !== AgentCategory.ToolUse) {
      throw new Error(
        `'${input.agent}' is not a tool-use agent. Use delegate_workflow for document processing.`,
      );
    }

    const ctx = getRequiredContext();

    // Resolve model: explicit input → parent model → first visible model
    const model = resolveVisibleModel(input.model ?? ctx.model ?? '');

    // Construct tool-use proposal (no file fields)
    // Memory paths are already validated by memoriesField's .superRefine() at schema parse time.
    const proposal = ToolUseAgentProposalSchema.parse({
      agentCategory: AgentCategory.ToolUse,
      agent: input.agent,
      model,
      instruction: input.instruction,
      memories: input.memories,
    } satisfies ToolUseAgentProposal);

    return proposeAndExecute(proposal, input.agent, ctx.streamId);
  }
}

// ============================================================================
// resume_agent tool - send follow-up instructions to a WAITING subagent
// ============================================================================

/** Schema for resume_agent tool. */
const ResumeAgentInputSchema = z.object({
  execution_id: z
    .string()
    .describe(
      'Execution ID of the tool-use subagent to resume (from the original delegate_agent result or /executions)',
    ),
  instruction: z
    .string()
    .describe(
      'Follow-up instruction for the subagent. Must be self-contained — the subagent retains its full conversation history, so you can reference its previous work.',
    ),
});

export type ResumeAgentInput = z.infer<typeof ResumeAgentInputSchema>;

/** Tool for resuming a WAITING tool-use subagent with follow-up instructions. */
export class ResumeAgentTool extends defineTool({
  name: 'resume_agent',
  description:
    'Send follow-up instructions to a WAITING tool-use subagent. The subagent keeps its full history, so reference previous work freely. Result arrives asynchronously like the original delegation.',
  schema: ResumeAgentInputSchema,
}) {
  protected async execute(input: ResumeAgentInput): Promise<ToolResult> {
    const handle = getHandle(input.execution_id);
    if (!(handle instanceof AgentExecutionHandle)) {
      throw new Error(
        `Execution '${input.execution_id}' not found or not an agent execution. Use the executions tool to check status.`,
      );
    }

    if (handle.category !== 'toolUse') {
      throw new Error(
        `Execution '${input.execution_id}' is a workflow agent. Only tool-use subagents can be resumed.`,
      );
    }

    const deliveryState = activeSubagentDelivery.get(input.execution_id);
    if (!deliveryState) {
      throw new Error(
        `Execution '${input.execution_id}' is no longer tracked for delivery. It may have already completed.`,
      );
    }

    // Only allow resume after the subagent has delivered its result and is
    // in WAITING state.  Resuming mid-cycle would race: the current cycle's
    // onBeforeWaiting could consume the gate reset and swallow the resumed
    // cycle's result.  Resetting the gate *before* sendFollowUp also
    // prevents concurrent resume calls from both passing the check — the
    // second caller sees hasDelivered === false and is rejected.
    if (!deliveryState.hasDelivered) {
      throw new Error(
        `'${handle.agentName}' is still processing. Wait for its result before sending a follow-up.`,
      );
    }
    deliveryState.hasDelivered = false;

    const framedInstruction = formatFollowUpInstruction(input.instruction);
    let result: Awaited<ReturnType<typeof sendFollowUp>>;
    try {
      result = await sendFollowUp(handle.childStreamId, framedInstruction);
    } catch (err) {
      // Restore the gate so the subagent's current result can still be
      // delivered if a transient error prevented sending.
      deliveryState.hasDelivered = true;
      throw err;
    }

    switch (result.status) {
      case 'sent':
      case 'queued':
        // Both are success paths.  'sent' is the normal case — the subagent
        // is blocked in WaitNode with an active flow context, so
        // appendFollowUp delivers directly.  'queued' is a fallback when
        // the context has been cleaned up but the stream status is still
        // WAITING.  Gate was already reset above.
        return {
          summary: `Follow-up sent to '${handle.agentName}'`,
          output: [
            `Follow-up instruction sent to '${handle.agentName}'. The subagent will process it and deliver a new result automatically.`,
            `Execution ID: ${input.execution_id}`,
          ].join('\n'),
        };
      case 'error':
        // Restore the gate — the follow-up was not accepted.
        deliveryState.hasDelivered = true;
        throw new Error(
          `Failed to send follow-up to '${handle.agentName}': ${result.message}`,
        );
      case 'no_session':
        // Restore the gate — the follow-up was not accepted.
        deliveryState.hasDelivered = true;
        throw new Error(
          `No active session for '${handle.agentName}' (stream status: ${result.streamStatus ?? 'unknown'}). The subagent may have stopped or its session expired.`,
        );
    }
  }
}
