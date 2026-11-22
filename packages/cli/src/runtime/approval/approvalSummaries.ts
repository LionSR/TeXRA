import {
  getModelLabel,
  getProposalFileGroups,
  type AgentProposalRequest,
  type BashRequest,
  type PluginTrustRequest,
  type RetryRequest,
  type ToolEditContent,
  type ToolEditRequest,
  type UserQuestionRequest,
  formatClippedList,
  formatHunkLines,
} from '@texra-ai/harness/schemas';
import { normalizeLineEndings } from '@texra/shared/utils/lineEndings';
import { hiddenRowsText } from '@cli/tui/overflowText';
import { CHILD_AGENT_COPY } from '@ui/copy/delegationApproval';
import { modelFailureText } from '@ui/copy/modelAccess';
import {
  pluginTrustFacts,
  REQUEST_ASK,
  WORKING_DIRECTORY_LABEL,
} from '@ui/copy/requestCards';
import { toolEditDiffLabel } from '@ui/copy/toolEditPreview';
import {
  SCRIPT_REQUEST_COPY,
  scriptRequestCallLine,
  scriptRequestFirstAgentLine,
} from '@ui/copy/scriptRequest';

import { type CliApprovalContent } from './approvalPrompts';

const TRUNCATED_DIFF_LINE_MARKER = ' … [line truncated]';
const TOOL_EDIT_APPROVAL_DIFF_MAX_CHARS = 12_000;
const TOOL_EDIT_APPROVAL_DIFF_MAX_LINES = 80;
const TOOL_EDIT_APPROVAL_DIFF_MAX_LINE_CHARS = 240;
const AGENT_PROPOSAL_INSTRUCTION_MAX_CHARS = 6_000;
const AGENT_PROPOSAL_INSTRUCTION_MAX_LINES = 40;

/** What a proposal launches, as its approval copy names it. */
export const agentProposalLabel = (
  proposal: Pick<AgentProposalRequest, 'task'>,
): string => (proposal.task ? 'program' : 'agent');
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

function agentProposalInstructionLines(instruction: string): readonly string[] {
  return normalizeLineEndings(instruction).split('\n');
}

function boundedAgentProposalInstructionLines(
  instructionLines: readonly string[],
): readonly string[] {
  return boundedLines(instructionLines, {
    maxLines: AGENT_PROPOSAL_INSTRUCTION_MAX_LINES,
    maxChars: AGENT_PROPOSAL_INSTRUCTION_MAX_CHARS,
    hiddenTrailer: (count) => hiddenRowsText(count, 'instruction lines'),
    truncateLine: (line) =>
      truncateLineToWidth(line, AGENT_PROPOSAL_INSTRUCTION_MAX_LINE_CHARS),
  });
}

function equalLines(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((line, index) => line === right[index])
  );
}

/** `label: a, b +N more`, bounded to `maxFiles` names. */
export function formatAgentProposalFileGroup(
  label: string,
  files: readonly string[],
  maxFiles = AGENT_PROPOSAL_FILE_GROUP_MAX_FILES,
): string {
  return `${label}: ${formatClippedList(files, maxFiles)}`;
}

/** A chat child: its name and tools, the first sentence of its system
 *  text, then the whole text. A program's child has none. */
function definedAgentLines(
  proposal: AgentProposalRequest,
  promptLines: readonly string[],
): readonly string[] {
  if (proposal.system === '') return [];
  return [
    CHILD_AGENT_COPY.heading(proposal.label, proposal.tools),
    CHILD_AGENT_COPY.summary(proposal.system),
    `${CHILD_AGENT_COPY.promptLabel}:`,
    ...promptLines.map((line) => `  ${line}`),
  ];
}

function agentProposalApprovalSummary(
  proposal: AgentProposalRequest,
  instructionLines: readonly string[],
  promptLines: readonly string[],
  boundFileGroups: boolean,
): string {
  const workingDirectory = proposal.workingDirectory?.trim();
  const fileGroups = getProposalFileGroups(proposal).map((group) =>
    boundFileGroups
      ? formatAgentProposalFileGroup(group.label, group.files)
      : formatAgentProposalFileGroup(group.label, group.files, Infinity),
  );
  // A script's request covers every `agent` call it makes: it names what it
  // asks for first, the calls it issued before it asked, and its source.
  const script = proposal.script;
  if (script)
    return [
      `Script agent request: ${SCRIPT_REQUEST_COPY.title(script)}`,
      SCRIPT_REQUEST_COPY.grant,
      ...definedAgentLines(proposal, promptLines),
      scriptRequestFirstAgentLine(
        proposal.label,
        getModelLabel(proposal.model),
        proposal.instruction,
      ),
      ...(script.calls.length > 0
        ? [
            `${SCRIPT_REQUEST_COPY.callsHeading}:`,
            ...script.calls.map((call) => `  ${scriptRequestCallLine(call)}`),
          ]
        : []),
      `${SCRIPT_REQUEST_COPY.code(script)}:`,
      ...instructionLines.map((line) => `  ${line}`),
    ].join('\n');
  return [
    `${REQUEST_ASK.proposal(proposal.task)} ${proposal.label} (${agentProposalLabel(proposal)})`,
    `Model: ${getModelLabel(proposal.model)}`,
    ...definedAgentLines(proposal, promptLines),
    ...(workingDirectory
      ? [`${WORKING_DIRECTORY_LABEL}: ${workingDirectory}`]
      : []),
    ...fileGroups,
    'Instruction:',
    ...instructionLines.map((line) => `  ${line}`),
  ].join('\n');
}

export function buildAgentProposalApprovalContent(
  proposal: AgentProposalRequest,
): CliApprovalContent {
  // A script's request shows its source where a proposal shows its prompt.
  const instructionLines = agentProposalInstructionLines(
    proposal.script?.source ?? proposal.instruction,
  );
  const boundedInstructionLines =
    boundedAgentProposalInstructionLines(instructionLines);
  // A chat child's system text is bounded as the instruction is.
  const promptLines = agentProposalInstructionLines(proposal.system);
  const boundedPromptLines = boundedAgentProposalInstructionLines(promptLines);
  const fileGroups = getProposalFileGroups(proposal);
  const hasHiddenContent =
    !equalLines(boundedInstructionLines, instructionLines) ||
    !equalLines(boundedPromptLines, promptLines) ||
    fileGroups.some(
      (group) => group.files.length > AGENT_PROPOSAL_FILE_GROUP_MAX_FILES,
    );
  const summary = agentProposalApprovalSummary(
    proposal,
    boundedInstructionLines,
    boundedPromptLines,
    true,
  );
  return hasHiddenContent
    ? {
        summary,
        details: () =>
          agentProposalApprovalSummary(
            proposal,
            instructionLines,
            promptLines,
            false,
          ),
      }
    : { summary };
}

export function formatRetryRequestMessage(payload: RetryRequest): string {
  return `${REQUEST_ASK.retry(payload.model)} (${payload.operation}): ${modelFailureText(payload.failure)}`;
}

export function formatBashApprovalSummary(payload: BashRequest): string {
  const cwd = payload.cwd ? `${WORKING_DIRECTORY_LABEL}: ${payload.cwd}\n` : '';
  return `${REQUEST_ASK.command}:\n${cwd}${payload.command}`;
}

/** What trusting a plugin asks: its name and version, a warning when it
 *  carries native code, where it is, and the whole review. */
export function formatPluginTrustSummary(payload: PluginTrustRequest): string {
  const facts = pluginTrustFacts(payload);
  return [
    `${REQUEST_ASK.pluginTrust} ${facts.plugin}:`,
    ...(payload.native ? [REQUEST_ASK.nativeCode] : []),
    facts.location,
    ...payload.review,
  ].join('\n');
}

/** What a tool edit's prompt shows: its diff's label (the tool, the file
 *  relative to the workspace, the line counts), and the diff. */
type ToolEditPrompt = Pick<
  ToolEditRequest,
  'relativePath' | 'sourceTool' | 'addedLines' | 'removedLines'
> &
  Pick<ToolEditContent, 'hunks'>;

function toolEditDiffLines(request: ToolEditPrompt): readonly string[] {
  const { hunks } = request;
  if (hunks.length === 0) return [];

  return [
    `--- ${request.relativePath}`,
    `+++ ${request.relativePath}`,
    ...formatHunkLines(hunks),
  ];
}

function boundedToolEditDiffLines(
  diffLines: readonly string[],
): readonly string[] {
  return boundedLines(diffLines, {
    maxLines: TOOL_EDIT_APPROVAL_DIFF_MAX_LINES,
    maxChars: TOOL_EDIT_APPROVAL_DIFF_MAX_CHARS,
    hiddenTrailer: (count) => hiddenRowsText(count, 'diff lines'),
    truncateLine: (line) =>
      truncateLineToWidth(line, TOOL_EDIT_APPROVAL_DIFF_MAX_LINE_CHARS),
  });
}

function toolEditApprovalSummary(
  request: ToolEditPrompt,
  diffLines: readonly string[],
): string {
  const header = toolEditDiffLabel(request).title;
  if (diffLines.length === 0) {
    return `${header}\nNo content changes proposed.`;
  }

  return `${header}\n${diffLines.join('\n')}`;
}

export function buildToolEditApprovalContent(
  request: ToolEditPrompt,
): CliApprovalContent {
  const diffLines = toolEditDiffLines(request);
  const boundedDiffLines = boundedToolEditDiffLines(diffLines);
  const summary = toolEditApprovalSummary(request, boundedDiffLines);
  return equalLines(boundedDiffLines, diffLines)
    ? { summary }
    : {
        summary,
        details: () => toolEditApprovalSummary(request, diffLines),
      };
}

export function formatUserQuestionPrompt(payload: UserQuestionRequest): string {
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
