import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';

import type { BashPermission } from '@shared/schemas';

import { ConfirmCard, CONFIRM_CARD_HORIZONTAL_DECORATION } from './ConfirmCard';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { KeyHints } from '../ui/KeyHints';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface BashApprovalProps {
  readonly availableRows?: number;
  readonly payload: BashPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export interface BashCommandDisplayLine {
  readonly kind: 'command' | 'overflow';
  readonly text: string;
}

const BASH_APPROVAL_TITLE = 'Run bash command?';
const MIN_BASH_COMMAND_WIDTH = 20;
const DEFAULT_BASH_COMMAND_ROWS = 12;
const COMPACT_BASH_COMMAND_ROWS = 3;
const BASH_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE = 7;
const BASH_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE = 5;

export function bashApprovalCommandRowsBudget({
  availableRows,
  columns,
  title = BASH_APPROVAL_TITLE,
}: {
  readonly availableRows?: number;
  readonly columns: number;
  readonly title?: string;
}): number {
  if (availableRows === undefined) return DEFAULT_BASH_COMMAND_ROWS;

  const titleWidth = Math.max(
    MIN_BASH_COMMAND_WIDTH,
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const titleRows = wrapAnsiToWidth(title, titleWidth).split('\n').length;
  const spaciousRows =
    availableRows -
    BASH_APPROVAL_SPACIOUS_FIXED_ROWS_EXCLUDING_TITLE -
    titleRows;
  if (spaciousRows > COMPACT_BASH_COMMAND_ROWS) {
    return spaciousRows;
  }

  const compactRows =
    availableRows -
    BASH_APPROVAL_COMPACT_FIXED_ROWS_EXCLUDING_TITLE -
    titleRows;
  return Math.max(1, Math.min(COMPACT_BASH_COMMAND_ROWS, compactRows));
}

export function bashCommandDisplayLines({
  command,
  width,
}: {
  readonly command: string;
  readonly width: number;
}): BashCommandDisplayLine[] {
  const commandWidth = Math.max(MIN_BASH_COMMAND_WIDTH, width);
  return command.split('\n').flatMap((line, index) =>
    wrapAnsiToWidth(`${index === 0 ? '$ ' : '  '}${line}`, commandWidth)
      .split('\n')
      .map((text): BashCommandDisplayLine => ({ kind: 'command', text })),
  );
}

export function maxBashCommandScrollOffset(
  totalLines: number,
  maxDisplayLines: number,
): number {
  if (
    maxDisplayLines <= COMPACT_BASH_COMMAND_ROWS ||
    totalLines <= maxDisplayLines
  ) {
    return 0;
  }
  return Math.max(0, totalLines - Math.max(1, maxDisplayLines - 1));
}

function overflowText(kind: 'more' | 'previous' | 'hidden', count: number) {
  if (kind === 'previous') return `... ${count} previous rows`;
  if (kind === 'hidden') return `... ${count} rows hidden`;
  return `... ${count} more rows`;
}

function compactHiddenCommandText({
  firstLine,
  hiddenLines,
  width,
}: {
  readonly firstLine: string;
  readonly hiddenLines: number;
  readonly width: number;
}): string {
  const suffix = ` ${overflowText('hidden', hiddenLines)}`;
  const prefixWidth = width - suffix.length;
  if (prefixWidth <= 0) return overflowText('hidden', hiddenLines);

  return `${firstLine.slice(0, prefixWidth).trimEnd()}${suffix}`;
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
  const lines = bashCommandDisplayLines({ command, width });
  if (maxDisplayLines <= 0 || lines.length <= maxDisplayLines) return lines;

  if (maxDisplayLines <= COMPACT_BASH_COMMAND_ROWS) {
    if (maxDisplayLines === 1) {
      return [
        {
          kind: 'overflow',
          text: compactHiddenCommandText({
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

  const offset = Math.max(
    0,
    Math.min(
      scrollOffset,
      maxBashCommandScrollOffset(lines.length, maxDisplayLines),
    ),
  );
  const hiddenBefore = offset;
  const reserveBefore = hiddenBefore > 0 ? 1 : 0;
  const contentSlotsWithoutAfter = Math.max(0, maxDisplayLines - reserveBefore);
  const reserveAfter = offset + contentSlotsWithoutAfter < lines.length ? 1 : 0;
  const visibleCount = Math.max(
    0,
    maxDisplayLines - reserveBefore - reserveAfter,
  );
  const visible = lines.slice(offset, offset + visibleCount);
  const hiddenAfter = Math.max(0, lines.length - (offset + visibleCount));

  return [
    ...(hiddenBefore > 0
      ? [
          {
            kind: 'overflow' as const,
            text: overflowText('previous', hiddenBefore),
          },
        ]
      : []),
    ...visible,
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

export function BashApproval(props: BashApprovalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [scrollOffset, setScrollOffset] = useState(0);
  const commandWidth = Math.max(
    MIN_BASH_COMMAND_WIDTH,
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const maxCommandRows = bashApprovalCommandRowsBudget({
    availableRows: props.availableRows,
    columns,
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
  const scrollable = maxScrollOffset > 0;
  const pageRows = Math.max(1, maxCommandRows - 2);
  const maxScrollOffsetRef = useRef(maxScrollOffset);
  const pageRowsRef = useRef(pageRows);
  const compactCommandLayout = maxCommandRows <= COMPACT_BASH_COMMAND_ROWS;
  const displayLines = boundedBashCommandDisplayLines({
    command: props.payload.command,
    maxDisplayLines: maxCommandRows,
    scrollOffset,
    width: commandWidth,
  });

  function scrollTo(next: number | ((currentOffset: number) => number)): void {
    setScrollOffset((current) => {
      const requested = typeof next === 'function' ? next(current) : next;
      return Math.max(0, Math.min(maxScrollOffsetRef.current, requested));
    });
  }

  useEffect(() => {
    maxScrollOffsetRef.current = maxScrollOffset;
    setScrollOffset((current) =>
      Math.max(0, Math.min(maxScrollOffset, current)),
    );
  }, [maxScrollOffset]);

  useEffect(() => {
    pageRowsRef.current = pageRows;
  }, [pageRows]);

  useInput(
    (_input, key) => {
      if (key.downArrow) scrollTo((current) => current + 1);
      else if (key.upArrow) scrollTo((current) => current - 1);
      else if (key.pageDown)
        scrollTo((current) => current + pageRowsRef.current);
      else if (key.pageUp) scrollTo((current) => current - pageRowsRef.current);
    },
    { isActive: scrollable },
  );

  return (
    <ConfirmCard
      borderStyle="double"
      color="yellow"
      title={BASH_APPROVAL_TITLE}
      alwaysAllow={{ kind: 'bash', label: 'approve session' }}
      onDecide={props.onDecide}
    >
      <Box
        marginY={scrollable || compactCommandLayout ? 0 : 1}
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
            { key: '↑/↓', action: 'scroll command' },
            { key: 'PgUp/PgDn', action: 'page' },
          ]}
        />
      ) : null}
    </ConfirmCard>
  );
}
