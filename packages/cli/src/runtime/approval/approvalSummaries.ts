import type {
  HostBashApprovalRequest,
  HostUserQuestionRequest,
} from '@agent/runtime/HostInteractions';
import { buildHunks, formatHunkHeader } from '@cli/runtime/diffHunks';
import {
  agentProposalCategoryLabel,
  getProposalFileGroups,
  type AgentProposalPermission,
  type RetryPermission,
} from '@shared/schemas';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';

import { cliRetryActionHint, classifyCliRetryAction } from './approvalPrompts';

const TRUNCATED_DIFF_LINE_MARKER = ' … [line truncated]';
const TOOL_EDIT_APPROVAL_DIFF_MAX_CHARS = 12_000;
const TOOL_EDIT_APPROVAL_DIFF_MAX_LINES = 80;
const TOOL_EDIT_APPROVAL_DIFF_MAX_LINE_CHARS = 240;
const AGENT_PROPOSAL_INSTRUCTION_MAX_CHARS = 6_000;
const AGENT_PROPOSAL_INSTRUCTION_MAX_LINES = 40;
const AGENT_PROPOSAL_INSTRUCTION_MAX_LINE_CHARS = 240;
const AGENT_PROPOSAL_FILE_GROUP_MAX_FILES = 10;

/**
 * Accumulate lines until either a max line count or a max total character
 * budget is hit, appending a "+N hidden" trailer when content was elided. Used
 * for both agent-proposal instructions and tool-edit diffs (same shape, two
 * different budgets and trailers).
 */
function boundedLines(
  lines: readonly string[],
  options: {
    readonly maxLines: number;
    readonly maxChars: number;
    readonly hiddenTrailer: (count: number) => string;
    readonly truncateLine: (line: string) => string;
  },
): readonly string[] {
  const visibleLines: string[] = [];
  let visibleChars = 0;
  let hiddenLineCount = 0;

  for (const [index, rawLine] of lines.entries()) {
    const line = options.truncateLine(rawLine);
    const separatorLength = visibleLines.length === 0 ? 0 : 1;
    const nextVisibleChars = visibleChars + separatorLength + line.length;
    if (
      visibleLines.length >= options.maxLines ||
      nextVisibleChars > options.maxChars
    ) {
      hiddenLineCount = lines.length - index;
      break;
    }

    visibleLines.push(line);
    visibleChars = nextVisibleChars;
  }

  if (hiddenLineCount > 0) {
    visibleLines.push(options.hiddenTrailer(hiddenLineCount));
  }

  return visibleLines;
}

function truncateLineToWidth(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const prefixLength = Math.max(
    0,
    maxChars - TRUNCATED_DIFF_LINE_MARKER.length,
  );
  return `${line.slice(0, prefixLength)}${TRUNCATED_DIFF_LINE_MARKER}`;
}

function boundedAgentProposalInstructionLines(
  instruction: string,
): readonly string[] {
  const instructionLines = instruction
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n');
  return boundedLines(instructionLines, {
    maxLines: AGENT_PROPOSAL_INSTRUCTION_MAX_LINES,
    maxChars: AGENT_PROPOSAL_INSTRUCTION_MAX_CHARS,
    hiddenTrailer: (count) => `… +${count} instruction lines hidden`,
    truncateLine: (line) =>
      truncateLineToWidth(line, AGENT_PROPOSAL_INSTRUCTION_MAX_LINE_CHARS),
  });
}

function formatAgentProposalFileGroup(
  label: string,
  files: readonly string[],
): string {
  const visibleFiles = files.slice(0, AGENT_PROPOSAL_FILE_GROUP_MAX_FILES);
  const hiddenCount = files.length - visibleFiles.length;
  const suffix = hiddenCount > 0 ? `, +${hiddenCount} more` : '';
  return `${label}: ${visibleFiles.join(', ')}${suffix}`;
}

export function formatAgentProposalApprovalSummary(
  proposal: AgentProposalPermission,
): string {
  const instructionLines = boundedAgentProposalInstructionLines(
    proposal.instruction,
  );
  const workingDirectory = proposal.workingDirectory?.trim();
  return [
    `Agent proposal requested: ${proposal.agent} (${agentProposalCategoryLabel(
      proposal.agentCategory,
    )})`,
    `Model: ${proposal.model}`,
    ...(workingDirectory ? [`Working directory: ${workingDirectory}`] : []),
    ...getProposalFileGroups(proposal).map((group) =>
      formatAgentProposalFileGroup(group.label, group.files),
    ),
    'Instruction:',
    ...instructionLines.map((line) => `  ${line}`),
  ].join('\n');
}

export function formatRetryRequestMessage(payload: RetryPermission): string {
  const message = `Retry requested (${payload.operation}): ${payload.errorMessage ?? 'unknown error'}`;
  const hint = cliRetryActionHint(classifyCliRetryAction(payload));
  return hint ? [message, hint].join('\n') : message;
}

export function formatBashApprovalSummary(
  request: HostBashApprovalRequest,
): string {
  const cwd = request.cwd ? `Directory: ${request.cwd}\n` : '';
  return `Command requested:\n${cwd}${request.command}`;
}

function toolEditDiffLines(
  request: ToolEditApprovalRequest,
): readonly string[] {
  const hunks = buildHunks(
    request.path,
    request.originalContent,
    request.proposedContent,
  );
  if (hunks.length === 0) return [];

  return [
    `--- ${request.path}`,
    `+++ ${request.path}`,
    ...hunks.flatMap((hunk) => [formatHunkHeader(hunk), ...hunk.lines]),
  ];
}

function boundedToolEditDiffLines(
  diffLines: readonly string[],
): readonly string[] {
  return boundedLines(diffLines, {
    maxLines: TOOL_EDIT_APPROVAL_DIFF_MAX_LINES,
    maxChars: TOOL_EDIT_APPROVAL_DIFF_MAX_CHARS,
    hiddenTrailer: (count) => `… +${count} diff lines hidden`,
    truncateLine: (line) =>
      truncateLineToWidth(line, TOOL_EDIT_APPROVAL_DIFF_MAX_LINE_CHARS),
  });
}

export function formatToolEditApprovalSummary(
  request: ToolEditApprovalRequest,
): string {
  const header = `Tool edit requested by ${request.sourceTool}: ${request.path}`;
  const diffLines = toolEditDiffLines(request);
  if (diffLines.length === 0) {
    return `${header}\nNo content changes proposed.`;
  }

  const visibleLines = boundedToolEditDiffLines(diffLines);

  return `${header}\nProposed diff:\n${visibleLines.join('\n')}`;
}

export function formatUserQuestionPrompt(
  payload: HostUserQuestionRequest,
): string {
  return payload.questions
    .map((question, index) => {
      const options = question.options
        .map((option, optionIndex) => {
          const description = option.description
            ? ` - ${option.description}`
            : '';
          return `  ${optionIndex + 1}. ${option.label}${description}`;
        })
        .join('\n');
      const multi = question.multiSelect
        ? ' Select comma-separated numbers.'
        : '';
      const free = question.allowFreeText ? ' Or type a custom answer.' : '';
      return `${index + 1}. ${question.question}\n${options}\n${multi}${free}`;
    })
    .join('\n\n');
}
