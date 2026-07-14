import { useMemo } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import {
  agentProposalCategoryLabel,
  getProposalFileGroups,
  type AgentProposalPermission,
} from '@shared/schemas';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

import { ConfirmCard } from './ConfirmCard';
import { COLOR_ACCENT } from '../ui/colors';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
  MIN_MODAL_CONTENT_WIDTH,
} from '../ui/theme';
import { confirmCardContentRowsBudget } from './confirmCardRowsBudget';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import {
  boundedScrollableLines,
  compactAwareMaxScrollOffset,
  scrollPageRows,
  type ScrollableDisplayLine,
} from '../render/scrollBounds';
import { fillRows } from '../render/terminalText';
import { KeyHints } from '../ui/KeyHints';
import { useScrollableOffset } from '../state/useScrollableOffset';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface AgentProposalProps {
  readonly availableRows?: number;
  readonly payload: AgentProposalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

const FILE_LIMIT = 5;
const DEFAULT_AGENT_PROPOSAL_INSTRUCTION_ROWS = 12;
const COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS = 3;
const AGENT_PROPOSAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE = 7;
const AGENT_PROPOSAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE = 5;

export type AgentProposalInstructionLine = ScrollableDisplayLine<'instruction'>;

const AGENT_PROPOSAL_HIDDEN_NOUN = 'prompt rows';

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
  return confirmCardContentRowsBudget({
    availableRows,
    columns,
    title,
    minContentWidth: MIN_MODAL_CONTENT_WIDTH,
    defaultRows: DEFAULT_AGENT_PROPOSAL_INSTRUCTION_ROWS,
    compactMaxRows: COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS,
    spaciousFixedRows: AGENT_PROPOSAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE,
    compactFixedRows: AGENT_PROPOSAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE,
    extraFixedRows: metadataRows,
  });
}

export function agentProposalInstructionDisplayLines({
  instruction,
  width,
}: {
  readonly instruction: string;
  readonly width: number;
}): AgentProposalInstructionLine[] {
  const instructionWidth = clampModalWidth(width);
  return instruction.split('\n').flatMap((line) => {
    const wrapped =
      line.length === 0
        ? ['']
        : wrapAnsiToWidth(line, instructionWidth).split('\n');
    return wrapped.map((text): AgentProposalInstructionLine => ({
      kind: 'instruction',
      text,
    }));
  });
}

export function maxAgentProposalInstructionScrollOffset(
  totalLines: number,
  maxDisplayLines: number,
): number {
  return compactAwareMaxScrollOffset({
    compactRows: COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS,
    maxDisplayLines,
    totalLines,
  });
}

function wrappedRows(text: string, width: number): number {
  return wrapAnsiToWidth(text, clampModalWidth(width)).split('\n').length;
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
  return boundedScrollableLines({
    compactRows: COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS,
    hiddenNoun: AGENT_PROPOSAL_HIDDEN_NOUN,
    lines: agentProposalInstructionDisplayLines({ instruction, width }),
    maxDisplayLines,
    scrollOffset,
    width,
  });
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
  const fileGroups = getProposalFileGroups(props.payload);
  const title = `Spawn ${props.payload.agent}?`;
  const instructionWidth = clampModalWidth(
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
  const { scrollOffset, scrollable } = useScrollableOffset({
    maxScrollOffset,
    pageRows: scrollPageRows({
      compactRows: COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS,
      maxDisplayLines: maxInstructionRows,
    }),
  });
  const compactInstructionLayout =
    maxInstructionRows <= COMPACT_AGENT_PROPOSAL_INSTRUCTION_ROWS;
  const showScrollHints = scrollable && maxInstructionRows > 1;
  const displayLines = boundedAgentProposalInstructionLines({
    instruction: props.payload.instruction,
    maxDisplayLines: maxInstructionRows,
    scrollOffset,
    width: instructionWidth,
  });

  return (
    <ConfirmCard
      borderStyle="double"
      color={COLOR_ACCENT}
      title={title}
      alwaysAllow={{
        kind: 'superYolo',
        label: DELEGATION_APPROVAL_COPY.cliAction,
      }}
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
            {fillRows(line.text, instructionWidth)}
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
