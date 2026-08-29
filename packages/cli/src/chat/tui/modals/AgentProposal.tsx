import { useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import { COLOR_ACCENT, COLOR_WARNING } from '@cli/tui/ui/colors';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
} from '@cli/tui/ui/theme';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { formatAgentProposalFileGroup } from '@cli/runtime/approval/approvalSummaries';
import { getRuntimeModelLabel } from '@model/runtimeModelRegistry';
import {
  AgentCategory,
  agentProposalCategoryLabel,
  getProposalFileGroups,
  type AgentProposalPermission,
} from '@shared/schemas';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';
import {
  WORKFLOW_CALL_REVIEW_COPY,
  WORKFLOW_SCRIPT_PROPOSAL_COPY,
  workflowCallCardLine,
  workflowScriptPlanSummary,
} from '@shared/copy/workflowScriptProposal';

import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface AgentProposalProps {
  readonly availableRows?: number;
  readonly payload: AgentProposalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

const FILE_LIMIT = 5;
const AGENT_PROPOSAL_HIDDEN_NOUN = 'prompt rows';

function wrappedRows(text: string, width: number): number {
  return wrapAnsiToWidth(text, clampModalWidth(width)).split('\n').length;
}

function fileGroupText(label: string, files: readonly string[]): string {
  return formatAgentProposalFileGroup(label, files, FILE_LIMIT);
}

interface MetadataSegment {
  readonly text: string;
  readonly bold?: boolean;
}

/**
 * One line of the proposal card's metadata block. Segments (rather than a
 * single bold prefix) let a line carry more than one bold span — e.g. the
 * `Model: X · Category: Y` line's two mid-line labels. `tone` maps to the
 * shared color/dim vocabulary; `marginTop` reproduces a blank spacer row
 * (not text) above the line, matching the plain-approval branch's file-group
 * Box marginTop.
 *
 * This is the single enumeration of the proposal card's content: both the
 * rendered JSX and the row-budget count (agentProposalMetadataRows) derive
 * from it, so a content change can no longer update one and silently
 * mis-budget the other.
 */
interface MetadataLine {
  readonly segments: readonly MetadataSegment[];
  readonly tone?: 'warning' | 'dim';
  readonly marginTop?: boolean;
}

function fileGroupLine(group: {
  readonly label: string;
  readonly files: readonly string[];
}): MetadataLine {
  const text = fileGroupText(group.label, group.files);
  const prefix = `${group.label}: `;
  return {
    segments: [
      { text: prefix, bold: true },
      { text: text.slice(prefix.length) },
    ],
  };
}

function fileGroupLines(
  fileGroups: ReturnType<typeof getProposalFileGroups>,
  heading?: string,
): MetadataLine[] {
  if (fileGroups.length === 0) {
    return [];
  }
  const lines = fileGroups.map((group) => fileGroupLine(group));
  if (heading !== undefined) {
    return [{ segments: [{ text: `${heading}:` }], tone: 'dim' }, ...lines];
  }
  const [first, ...rest] = lines;
  return [{ ...first, marginTop: true }, ...rest];
}

function agentProposalMetadataLines({
  fileGroups,
  payload,
}: {
  readonly fileGroups: ReturnType<typeof getProposalFileGroups>;
  readonly payload: AgentProposalPermission;
}): MetadataLine[] {
  if (
    payload.agentCategory === AgentCategory.Workflow &&
    payload.workflowScript
  ) {
    const workflow = payload.workflowScript;
    return [
      {
        segments: [
          { text: workflow.name, bold: true },
          { text: ` · ${workflowScriptPlanSummary(workflow)}` },
        ],
      },
      {
        segments: [
          {
            text: WORKFLOW_SCRIPT_PROPOSAL_COPY.defaults(
              payload.agent,
              getRuntimeModelLabel(payload.model),
            ),
          },
        ],
      },
      {
        segments: [{ text: WORKFLOW_SCRIPT_PROPOSAL_COPY.costWarning }],
        tone: 'warning',
      },
      {
        segments: [{ text: WORKFLOW_CALL_REVIEW_COPY.cliReviewExplanation }],
        tone: 'dim',
      },
      {
        segments: [
          {
            text:
              workflow.tasks.length > 0
                ? WORKFLOW_SCRIPT_PROPOSAL_COPY.declaredItemsNote
                : WORKFLOW_SCRIPT_PROPOSAL_COPY.dynamicCallsNote,
          },
        ],
        tone: 'dim',
      },
      ...fileGroupLines(fileGroups, WORKFLOW_SCRIPT_PROPOSAL_COPY.filesHeading),
      {
        segments: [{ text: `Script: ${workflow.scriptPath}` }],
        tone: 'dim',
      },
    ];
  }

  const lines: MetadataLine[] = [
    {
      segments: [
        { text: 'Model: ', bold: true },
        { text: getRuntimeModelLabel(payload.model) },
        { text: ' · ' },
        { text: 'Category: ', bold: true },
        { text: agentProposalCategoryLabel(payload.agentCategory) },
      ],
    },
  ];
  if (payload.workflowCall) {
    lines.push({
      segments: [{ text: workflowCallCardLine(payload.workflowCall) }],
      tone: 'dim',
    });
  }
  if (payload.workingDirectory) {
    lines.push({
      segments: [
        { text: 'Directory: ', bold: true },
        { text: payload.workingDirectory },
      ],
    });
  }
  lines.push(...fileGroupLines(fileGroups));
  lines.push({
    segments: [{ text: DELEGATION_APPROVAL_COPY.cliExplanation }],
    tone: 'dim',
  });
  return lines;
}

function metadataLinesRows(
  lines: readonly MetadataLine[],
  width: number,
): number {
  return (
    1 +
    lines.reduce(
      (rows, line) =>
        rows +
        (line.marginTop ? 1 : 0) +
        wrappedRows(
          line.segments.map((segment) => segment.text).join(''),
          width,
        ),
      0,
    )
  );
}

/** Row-count view of {@link agentProposalMetadataLines} for the scrollable
 * prompt-area budget — same descriptor list, counted rather than painted, so
 * the two can never drift. */
export function agentProposalMetadataRows({
  fileGroups,
  payload,
  width,
}: {
  readonly fileGroups: ReturnType<typeof getProposalFileGroups>;
  readonly payload: AgentProposalPermission;
  readonly width: number;
}): number {
  return metadataLinesRows(
    agentProposalMetadataLines({ fileGroups, payload }),
    width,
  );
}

function MetadataLineRow(props: {
  readonly line: MetadataLine;
}): React.JSX.Element {
  const { line } = props;
  const text = (
    <Text
      color={line.tone === 'warning' ? COLOR_WARNING : undefined}
      dimColor={line.tone === 'dim'}
    >
      {line.segments.map((segment, index) =>
        segment.bold ? (
          <Text key={index} bold>
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
  return line.marginTop ? <Box marginTop={1}>{text}</Box> : text;
}

export function AgentProposal(props: AgentProposalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [feedbackMode, setFeedbackMode] = useState(false);
  const fileGroups = getProposalFileGroups(props.payload);
  const workflowScript =
    props.payload.agentCategory === AgentCategory.Workflow
      ? props.payload.workflowScript
      : undefined;
  const workflowCall = props.payload.workflowCall;
  let title = `Spawn ${props.payload.agent}?`;
  if (workflowScript) {
    title = `Approve multi-agent workflow ${workflowScript.name}?`;
  } else if (workflowCall) {
    title = `Run workflow call ${workflowCall.label}?`;
  }
  const instructionWidth = clampModalWidth(
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const metadataLines = agentProposalMetadataLines({
    fileGroups,
    payload: props.payload,
  });
  const metadataRows = metadataLinesRows(metadataLines, instructionWidth);
  const maxInstructionRows = scrollableModalTextRowsBudget({
    availableRows: props.availableRows,
    columns,
    extraFixedRows: metadataRows,
    title,
  });

  return (
    <ConfirmCard
      borderStyle="double"
      color={COLOR_ACCENT}
      title={title}
      rejectionMode="feedback"
      alwaysAllow={{
        kind: 'superYolo',
        label: DELEGATION_APPROVAL_COPY.cliAction,
      }}
      extraActions={
        workflowScript
          ? [
              {
                key: 'p',
                label: WORKFLOW_CALL_REVIEW_COPY.phase,
                decision: { accepted: true, callReview: 'phase' },
              },
              {
                key: 'c',
                label: WORKFLOW_CALL_REVIEW_COPY.call,
                decision: { accepted: true, callReview: 'call' },
              },
            ]
          : []
      }
      onFeedbackModeChange={setFeedbackMode}
      onDecide={props.onDecide}
    >
      <Box marginTop={1} flexDirection="column">
        {metadataLines.map((line, index) => (
          <MetadataLineRow key={index} line={line} />
        ))}
      </Box>
      <ScrollableModalText
        hiddenNoun={AGENT_PROPOSAL_HIDDEN_NOUN}
        maxRows={maxInstructionRows}
        scrollActive={!feedbackMode}
        scrollHint="scroll prompt"
        text={props.payload.instruction}
        width={instructionWidth}
      />
    </ConfirmCard>
  );
}
