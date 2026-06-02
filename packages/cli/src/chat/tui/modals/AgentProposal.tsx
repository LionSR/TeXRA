import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';

import {
  agentProposalCategoryLabel,
  getProposalFileGroups,
  type AgentProposalPermission,
} from '@shared/schemas';

import { ConfirmCard, CONFIRM_CARD_HORIZONTAL_DECORATION } from './ConfirmCard';
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
  if (maxDisplayLines <= 0) return 0;
  if (totalLines <= maxDisplayLines) return 0;
  if (maxDisplayLines <= COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS) {
    return Math.max(0, totalLines - Math.max(1, maxDisplayLines - 1));
  }

  return maxScrollableRowOffset({
    compactRows: COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS,
    maxDisplayLines,
    totalLines,
  });
}

function agentProposalInstructionPageRows(maxInstructionRows: number): number {
  return maxInstructionRows <= COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS
    ? Math.max(1, maxInstructionRows - 1)
    : Math.max(1, maxInstructionRows - 2);
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

  const prefix = clipToWidth(firstLine, prefixWidth).trimEnd();
  if (prefix.length === 0) {
    return clipToWidth(overflowText('hidden', hiddenLines), width);
  }

  return `${prefix}${suffix}`;
}

function compactScrollStatusText({
  hiddenAfter,
  hiddenBefore,
  width,
}: {
  readonly hiddenAfter: number;
  readonly hiddenBefore: number;
  readonly width: number;
}): string {
  const text =
    hiddenBefore > 0 && hiddenAfter > 0
      ? `... ${hiddenBefore} previous, ${hiddenAfter} more rows`
      : hiddenBefore > 0
        ? overflowText('previous', hiddenBefore)
        : overflowText('more', hiddenAfter);
  return clipToWidth(text, width);
}

function wrappedRows(text: string, width: number): number {
  return wrapAnsiToWidth(text, Math.max(MIN_AGENT_PROPOSAL_WIDTH, width)).split(
    '\n',
  ).length;
}

function fileGroupText(label: string, files: readonly string[]): string {
  const visible = files.slice(0, FILE_LIMIT);
  const hidden = files.length - visible.length;
  return `${label}: ${visible.join(', ')}${hidden > 0 ? `, +${hidden} more` : ''}`;
}

function agentProposalMetadataRows({
  fileGroups,
  payload,
  width,
}: {
  readonly fileGroups: ReturnType<typeof getProposalFileGroups>;
  readonly payload: AgentProposalPermission;
  readonly width: number;
}): number {
  return (
    1 +
    wrappedRows(`Model: ${payload.model}`, width) +
    wrappedRows(
      `Category: ${agentProposalCategoryLabel(payload.agentCategory)}`,
      width,
    ) +
    (payload.workingDirectory
      ? wrappedRows(`Directory: ${payload.workingDirectory}`, width)
      : 0) +
    (fileGroups.length > 0
      ? 1 +
        fileGroups.reduce(
          (rows, group) =>
            rows + wrappedRows(fileGroupText(group.label, group.files), width),
          0,
        )
      : 0)
  );
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
    const contentRows = Math.max(1, maxDisplayLines - 1);
    const offset = Math.max(
      0,
      Math.min(
        scrollOffset,
        maxAgentProposalInstructionScrollOffset(lines.length, maxDisplayLines),
      ),
    );

    if (maxDisplayLines === 1) {
      return [
        {
          kind: 'overflow',
          text: compactHiddenInstructionText({
            firstLine: lines[offset]?.text ?? '',
            hiddenLines: lines.length - 1,
            width,
          }),
        },
      ];
    }

    const visible = lines.slice(offset, offset + contentRows);
    const hiddenBefore = offset;
    const hiddenAfter = Math.max(0, lines.length - (offset + visible.length));
    return [
      ...visible,
      {
        kind: 'overflow',
        text: compactScrollStatusText({
          hiddenAfter,
          hiddenBefore,
          width,
        }),
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
  const text = fileGroupText(props.label, props.files);
  const prefix = `${props.label}: `;
  return (
    <Text>
      <Text bold>{prefix}</Text>
      {text.slice(prefix.length)}
    </Text>
  );
}

export function AgentProposal(props: AgentProposalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [scrollOffset, setScrollOffset] = useState(0);
  const fileGroups = getProposalFileGroups(props.payload);
  const title = `Spawn ${props.payload.agent}?`;
  const instructionWidth = Math.max(
    MIN_AGENT_PROPOSAL_WIDTH,
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const metadataRows = agentProposalMetadataRows({
    fileGroups,
    payload: props.payload,
    width: instructionWidth,
  });
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
  const pageRows = agentProposalInstructionPageRows(maxInstructionRows);
  const compactInstructionLayout =
    maxInstructionRows <= COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS;
  const showScrollHints = scrollable && maxInstructionRows > 1;
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
      {showScrollHints ? (
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
