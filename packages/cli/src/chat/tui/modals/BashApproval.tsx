import { useMemo } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import type { BashPermission } from '@shared/schemas';

import { ConfirmCard } from './ConfirmCard';
import { COLOR_WARNING } from '../ui/colors';
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
import { truncateToWidth } from '../render/terminalText';
import { KeyHints } from '../ui/KeyHints';
import { useScrollableOffset } from '../state/useScrollableOffset';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface BashApprovalProps {
  readonly availableRows?: number;
  readonly payload: BashPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export type BashCommandDisplayLine = ScrollableDisplayLine<'command'>;

const COMMAND_APPROVAL_TITLE = 'Run command?';
const DEFAULT_BASH_COMMAND_ROWS = 12;
const COMPACT_BASH_COMMAND_ROWS = 3;
const BASH_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE = 7;
const BASH_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE = 5;

export function bashApprovalCommandRowsBudget({
  availableRows,
  columns,
  extraFixedRows = 0,
  title = COMMAND_APPROVAL_TITLE,
}: {
  readonly availableRows?: number;
  readonly columns: number;
  readonly extraFixedRows?: number;
  readonly title?: string;
}): number {
  return confirmCardContentRowsBudget({
    availableRows,
    columns,
    title,
    minContentWidth: MIN_MODAL_CONTENT_WIDTH,
    defaultRows: DEFAULT_BASH_COMMAND_ROWS,
    compactMaxRows: COMPACT_BASH_COMMAND_ROWS,
    spaciousFixedRows: BASH_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE,
    compactFixedRows: BASH_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE,
    extraFixedRows,
  });
}

export function bashCommandDisplayLines({
  command,
  width,
}: {
  readonly command: string;
  readonly width: number;
}): BashCommandDisplayLine[] {
  const commandWidth = clampModalWidth(width);
  return command.split('\n').flatMap((line, index) =>
    wrapAnsiToWidth(`${index === 0 ? '$ ' : '  '}${line}`, commandWidth)
      .split('\n')
      .map((text): BashCommandDisplayLine => ({ kind: 'command', text })),
  );
}

export function bashCwdDisplayLine({
  cwd,
  width,
}: {
  readonly cwd?: string;
  readonly width: number;
}): string | undefined {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) return undefined;

  return truncateToWidth(`Directory: ${trimmedCwd}`, clampModalWidth(width));
}

export function maxBashCommandScrollOffset(
  totalLines: number,
  maxDisplayLines: number,
): number {
  return compactAwareMaxScrollOffset({
    compactRows: COMPACT_BASH_COMMAND_ROWS,
    maxDisplayLines,
    totalLines,
  });
}

export function bashApprovalPageRows(maxCommandRows: number): number {
  return scrollPageRows({
    compactRows: COMPACT_BASH_COMMAND_ROWS,
    maxDisplayLines: maxCommandRows,
  });
}

export function boundedBashCommandDisplayLines({
  command,
  maxDisplayLines,
  scrollOffset = 0,
  width,
}: {
  readonly command: string;
  readonly maxDisplayLines: number;
  readonly scrollOffset?: number;
  readonly width: number;
}): BashCommandDisplayLine[] {
  return boundedScrollableLines({
    compactRows: COMPACT_BASH_COMMAND_ROWS,
    lines: bashCommandDisplayLines({ command, width }),
    maxDisplayLines,
    scrollOffset,
    width,
  });
}

export function BashApproval(props: BashApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const commandWidth = clampModalWidth(
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const cwdLine = useMemo(
    () => bashCwdDisplayLine({ cwd: props.payload.cwd, width: commandWidth }),
    [commandWidth, props.payload.cwd],
  );
  const maxCommandRows = bashApprovalCommandRowsBudget({
    availableRows: props.availableRows,
    columns,
    extraFixedRows: cwdLine ? 1 : 0,
  });
  const commandRows = useMemo(
    () =>
      bashCommandDisplayLines({
        command: props.payload.command,
        width: commandWidth,
      }).length,
    [commandWidth, props.payload.command],
  );
  const maxScrollOffset = maxBashCommandScrollOffset(
    commandRows,
    maxCommandRows,
  );
  const { scrollOffset, scrollable } = useScrollableOffset({
    maxScrollOffset,
    pageRows: bashApprovalPageRows(maxCommandRows),
  });
  const compactCommandLayout = maxCommandRows <= COMPACT_BASH_COMMAND_ROWS;
  const showScrollHints = scrollable && maxCommandRows > 1;
  const displayLines = boundedBashCommandDisplayLines({
    command: props.payload.command,
    maxDisplayLines: maxCommandRows,
    scrollOffset,
    width: commandWidth,
  });

  return (
    <ConfirmCard
      borderStyle="double"
      color={COLOR_WARNING}
      title={COMMAND_APPROVAL_TITLE}
      alwaysAllow={{ kind: 'bash', label: 'approve all' }}
      onDecide={props.onDecide}
    >
      {cwdLine ? <Text dimColor>{cwdLine}</Text> : null}
      <Box
        marginY={scrollable || compactCommandLayout || cwdLine ? 0 : 1}
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
            { key: '↑/↓', action: 'scroll command' },
            { key: 'PgUp/PgDn', action: 'page' },
          ]}
        />
      ) : null}
    </ConfirmCard>
  );
}
