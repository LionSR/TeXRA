import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';

import {
  getProposalFileGroups,
  type AgentProposalPermission,
} from '@shared/schemas';

import { ConfirmCard, CONFIRM_CARD_HORIZONTAL_DECORATION } from './ConfirmCard';
import { agentProposalCategoryLabel } from './AgentProposalDisplay';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import {
  maxScrollableRowOffset,
  scrollBoundedRows,
} from '../render/scrollBounds';
import { clipToWidth, textDisplayWidth } from '../render/terminalText';
import { KeyHints } from '../ui/KeyHints';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface AgentProposalProps {
  readonly availableRows?: number;
  readonly payload: AgentProposalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

const FILE_LIMIT = 5;
const MIN_AGENT_PROPOSAL_WIDTH = 20;
const DEFAULT_AGENT_PROPOSAL_INSTRUCTION_ROWS = 12;
const COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS = 3;
const AGENT_PROPOSAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE = 7;
const AGENT_PROPOSAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE = 5;

export interface AgentProposalInstructionLine {
  readonly kind: 'instruction' | 'overflow';
  readonly text: string;
}

export function agentProposalInstructionRowsBudget({
  availableRows,
  columns,
  metadataRows,
  title,
}: {
  readonly availableRows?: number;
  readonly columns: number;
  readonly metadataRows: number;
  readonly title: string;
}): number {
  if (availableRows === undefined)
    return DEFAULT_AGENT_PROPOSAL_INSTRUCTION_ROWS;

  const titleWidth = Math.max(
    MIN_AGENT_PROPOSAL_WIDTH,
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const titleRows = wrapAnsiToWidth(title, titleWidth).split('\n').length;
  const spaciousRows =
    availableRows -
    titleRows -
    metadataRows -
    AGENT_PROPOSAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE;
  if (spaciousRows > COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS) {
    return spaciousRows;
  }

  const compactRows =
    availableRows -
    titleRows -
    metadataRows -
    AGENT_PROPOSAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE;
  return Math.max(
    1,
    Math.min(COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS, compactRows),
  );
}

export function agentProposalInstructionDisplayLines({
  instruction,
  width,
}: {
  readonly instruction: string;
  readonly width: number;
}): AgentProposalInstructionLine[] {
  const instructionWidth = Math.max(MIN_AGENT_PROPOSAL_WIDTH, width);
  return instruction.split('\n').flatMap((line) => {
    const wrapped =
      line.length === 0
        ? ['']
        : wrapAnsiToWidth(line, instructionWidth).split('\n');
    return wrapped.map(
      (text): AgentProposalInstructionLine => ({
        kind: 'instruction',
        text,
      }),
    );
  });
}

export function maxAgentProposalInstructionScrollOffset(
  totalLines: number,
  maxDisplayLines: number,
): number {
  return maxScrollableRowOffset({
    compactRows: COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS,
    maxDisplayLines,
    totalLines,
  });
}

function overflowText(kind: 'more' | 'previous' | 'hidden', count: number) {
  if (kind === 'previous') return `... ${count} previous rows`;
  if (kind === 'hidden') return `... ${count} prompt rows hidden`;
  return `... ${count} more rows`;
}

function compactHiddenInstructionText({
  firstLine,
  hiddenLines,
  width,
}: {
  readonly firstLine: string;
  readonly hiddenLines: number;
  readonly width: number;
}): string {
  const suffix = ` ${overflowText('hidden', hiddenLines)}`;
  const prefixWidth = width - textDisplayWidth(suffix);
  if (prefixWidth <= 0) {
    return clipToWidth(overflowText('hidden', hiddenLines), width);
  }

  return `${clipToWidth(firstLine, prefixWidth).trimEnd()}${suffix}`;
}

export function boundedAgentProposalInstructionLines({
  instruction,
  maxDisplayLines,
  scrollOffset = 0,
  width,
}: {
  readonly instruction: string;
  readonly maxDisplayLines: number;
  readonly scrollOffset?: number;
  readonly width: number;
}): AgentProposalInstructionLine[] {
  const lines = agentProposalInstructionDisplayLines({ instruction, width });
  if (maxDisplayLines <= 0 || lines.length <= maxDisplayLines) return lines;

  if (maxDisplayLines <= COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS) {
    if (maxDisplayLines === 1) {
      return [
        {
          kind: 'overflow',
          text: compactHiddenInstructionText({
            firstLine: lines[0]?.text ?? '',
            hiddenLines: lines.length - 1,
            width,
          }),
        },
      ];
    }

    const visibleCount = Math.max(1, maxDisplayLines - 1);
    const visible = lines.slice(0, visibleCount);
    return [
      ...visible,
      {
        kind: 'overflow',
        text: overflowText('hidden', lines.length - visible.length),
      },
    ];
  }

  const { hiddenAfter, hiddenBefore, visibleRows } = scrollBoundedRows({
    compactRows: COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS,
    maxDisplayLines,
    rows: lines,
    scrollOffset,
  });

  return [
    ...(hiddenBefore > 0
      ? [
          {
            kind: 'overflow' as const,
            text: overflowText('previous', hiddenBefore),
          },
        ]
      : []),
    ...visibleRows,
    ...(hiddenAfter > 0
      ? [
          {
            kind: 'overflow' as const,
            text: overflowText('more', hiddenAfter),
          },
        ]
      : []),
  ];
}

function FileGroup(props: {
  readonly label: string;
  readonly files: readonly string[];
}): React.JSX.Element {
  const visible = props.files.slice(0, FILE_LIMIT);
  const hidden = props.files.length - visible.length;
  return (
    <Text>
      <Text bold>{props.label}: </Text>
      {visible.join(', ')}
      {hidden > 0 ? `, +${hidden} more` : ''}
    </Text>
  );
}

export function AgentProposal(props: AgentProposalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [scrollOffset, setScrollOffset] = useState(0);
  const fileGroups = getProposalFileGroups(props.payload);
  const title = `Spawn ${props.payload.agent}?`;
  const metadataRows =
    1 +
    2 +
    (props.payload.workingDirectory ? 1 : 0) +
    (fileGroups.length > 0 ? 1 + fileGroups.length : 0);
  const instructionWidth = Math.max(
    MIN_AGENT_PROPOSAL_WIDTH,
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const maxInstructionRows = agentProposalInstructionRowsBudget({
    availableRows: props.availableRows,
    columns,
    metadataRows,
    title,
  });
  const instructionRows = useMemo(
    () =>
      agentProposalInstructionDisplayLines({
        instruction: props.payload.instruction,
        width: instructionWidth,
      }).length,
    [instructionWidth, props.payload.instruction],
  );
  const maxScrollOffset = maxAgentProposalInstructionScrollOffset(
    instructionRows,
    maxInstructionRows,
  );
  const scrollable = maxScrollOffset > 0;
  const pageRows = Math.max(1, maxInstructionRows - 2);
  const compactInstructionLayout =
    maxInstructionRows <= COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS;
  const displayLines = boundedAgentProposalInstructionLines({
    instruction: props.payload.instruction,
    maxDisplayLines: maxInstructionRows,
    scrollOffset,
    width: instructionWidth,
  });

  function scrollTo(next: number | ((currentOffset: number) => number)): void {
    setScrollOffset((current) => {
      const requested = typeof next === 'function' ? next(current) : next;
      return Math.max(0, Math.min(maxScrollOffset, requested));
    });
  }

  useEffect(() => {
    setScrollOffset((current) =>
      Math.max(0, Math.min(maxScrollOffset, current)),
    );
  }, [maxScrollOffset]);

  useInput(
    (_input, key) => {
      if (key.downArrow) scrollTo((current) => current + 1);
      else if (key.upArrow) scrollTo((current) => current - 1);
      else if (key.pageDown) scrollTo((current) => current + pageRows);
      else if (key.pageUp) scrollTo((current) => current - pageRows);
    },
    { isActive: scrollable },
  );

  return (
    <ConfirmCard
      borderStyle="double"
      color="magenta"
      title={title}
      onDecide={props.onDecide}
    >
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Model: </Text>
          {props.payload.model}
        </Text>
        <Text>
          <Text bold>Category: </Text>
          {agentProposalCategoryLabel(props.payload.agentCategory)}
        </Text>
        {props.payload.workingDirectory ? (
          <Text>
            <Text bold>Directory: </Text>
            {props.payload.workingDirectory}
          </Text>
        ) : null}
        {fileGroups.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            {fileGroups.map((group) => (
              <FileGroup
                key={group.label}
                label={group.label}
                files={group.files}
              />
            ))}
          </Box>
        ) : null}
      </Box>
      <Box
        marginY={scrollable || compactInstructionLayout ? 0 : 1}
        flexDirection="column"
      >
        {displayLines.map((line, index) => (
          <Text key={index} dimColor={line.kind === 'overflow'}>
            {line.text}
          </Text>
        ))}
      </Box>
      {scrollable ? (
        <KeyHints
          confirmCancel={false}
          hints={[
            { key: '↑/↓', action: 'scroll prompt' },
            { key: 'PgUp/PgDn', action: 'page' },
          ]}
        />
      ) : null}
    </ConfirmCard>
  );
}
