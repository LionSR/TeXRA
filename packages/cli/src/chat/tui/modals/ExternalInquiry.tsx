import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';

import type { ExternalInquiryPermission } from '@shared/schemas';

import { CONFIRM_CARD_HORIZONTAL_DECORATION } from './ConfirmCard';
import { BaseTextInput } from '../input/BaseTextInput';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import {
  maxScrollableRowOffset,
  scrollBoundedRows,
} from '../render/scrollBounds';
import { KeyHints } from '../ui/KeyHints';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface ExternalInquiryProps {
  readonly availableRows?: number;
  readonly payload: ExternalInquiryPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export interface ExternalInquiryDisplayLine {
  readonly kind: 'question' | 'overflow';
  readonly text: string;
}

const MIN_EXTERNAL_INQUIRY_WIDTH = 20;
const DEFAULT_EXTERNAL_INQUIRY_QUESTION_ROWS = 16;
const COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS = 3;
const EXTERNAL_INQUIRY_FIXED_ROWS = 7;

export function externalInquiryAnswerRowsBudget(
  availableRows: number | undefined,
): number {
  if (availableRows === undefined || availableRows >= 18) return 3;
  if (availableRows >= 13) return 2;
  return 1;
}

export function externalInquiryQuestionRowsBudget({
  answerRows,
  availableRows,
}: {
  readonly answerRows: number;
  readonly availableRows?: number;
}): number {
  if (availableRows === undefined)
    return DEFAULT_EXTERNAL_INQUIRY_QUESTION_ROWS;
  return Math.max(1, availableRows - EXTERNAL_INQUIRY_FIXED_ROWS - answerRows);
}

function overflowText(kind: 'previous' | 'more' | 'hidden', count: number) {
  if (kind === 'previous') return `... ${count} previous rows`;
  if (kind === 'hidden') return `... ${count} rows hidden`;
  return `... ${count} more rows`;
}

export function externalInquiryQuestionLines({
  question,
  width,
}: {
  readonly question: string;
  readonly width: number;
}): ExternalInquiryDisplayLine[] {
  const questionWidth = Math.max(MIN_EXTERNAL_INQUIRY_WIDTH, width);
  return question.split('\n').flatMap((line) =>
    wrapAnsiToWidth(line, questionWidth)
      .split('\n')
      .map((text): ExternalInquiryDisplayLine => ({ kind: 'question', text })),
  );
}

export function maxExternalInquiryQuestionScrollOffset(
  totalLines: number,
  maxDisplayLines: number,
): number {
  return maxScrollableRowOffset({
    compactRows: COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS,
    maxDisplayLines,
    totalLines,
  });
}

export function boundedExternalInquiryQuestionLines({
  maxDisplayLines,
  question,
  scrollOffset = 0,
  width,
}: {
  readonly maxDisplayLines: number;
  readonly question: string;
  readonly scrollOffset?: number;
  readonly width: number;
}): ExternalInquiryDisplayLine[] {
  const lines = externalInquiryQuestionLines({ question, width });
  if (maxDisplayLines <= 0 || lines.length <= maxDisplayLines) return lines;

  if (maxDisplayLines <= COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS) {
    if (maxDisplayLines === 1) {
      return [
        {
          kind: 'overflow',
          text: overflowText('hidden', lines.length),
        },
      ];
    }
    const visible = lines.slice(0, Math.max(1, maxDisplayLines - 1));
    return [
      ...visible,
      {
        kind: 'overflow',
        text: overflowText('hidden', lines.length - visible.length),
      },
    ];
  }

  const { hiddenAfter, hiddenBefore, visibleRows } = scrollBoundedRows({
    compactRows: COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS,
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

export function ExternalInquiry(
  props: ExternalInquiryProps,
): React.JSX.Element {
  const { columns } = useWindowSize();
  const [answer, setAnswer] = useState('');
  const [questionOffset, setQuestionOffset] = useState(0);
  const contentWidth = Math.max(
    MIN_EXTERNAL_INQUIRY_WIDTH,
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const answerRows = externalInquiryAnswerRowsBudget(props.availableRows);
  const questionRows = externalInquiryQuestionRowsBudget({
    answerRows,
    availableRows: props.availableRows,
  });
  const questionLineCount = useMemo(
    () =>
      externalInquiryQuestionLines({
        question: props.payload.question,
        width: contentWidth,
      }).length,
    [contentWidth, props.payload.question],
  );
  const maxQuestionOffset = maxExternalInquiryQuestionScrollOffset(
    questionLineCount,
    questionRows,
  );
  const questionScrollable = maxQuestionOffset > 0;
  const pageRows = Math.max(1, questionRows - 2);
  const questionDisplayLines = boundedExternalInquiryQuestionLines({
    maxDisplayLines: questionRows,
    question: props.payload.question,
    scrollOffset: questionOffset,
    width: contentWidth,
  });

  function scrollQuestion(
    next: number | ((currentOffset: number) => number),
  ): void {
    setQuestionOffset((current) => {
      const requested = typeof next === 'function' ? next(current) : next;
      return Math.max(0, Math.min(maxQuestionOffset, requested));
    });
  }

  useEffect(() => {
    setQuestionOffset((current) =>
      Math.max(0, Math.min(maxQuestionOffset, current)),
    );
  }, [maxQuestionOffset]);

  useInput((input, key) => {
    if (key.escape) {
      props.onDecide({
        accepted: false,
        userMessage: 'External inquiry skipped by user.',
      });
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'r') {
      const feedback = answer.trim();
      props.onDecide({
        accepted: false,
        userMessage:
          feedback.length > 0 ? feedback : 'External inquiry rejected by user.',
      });
      return;
    }
    if (key.pageDown) {
      scrollQuestion((current) => current + pageRows);
      return;
    }
    if (key.pageUp) {
      scrollQuestion((current) => current - pageRows);
    }
  });

  return (
    <Box
      borderStyle="single"
      borderColor="green"
      flexDirection="column"
      paddingX={1}
      width={columns}
    >
      <Text bold color="green">
        Agent asks:
      </Text>
      <Box marginY={questionScrollable ? 0 : 1} flexDirection="column">
        {questionDisplayLines.map((line, index) => (
          <Text key={index} dimColor={line.kind === 'overflow'}>
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text>{'> '}</Text>
        <Box flexGrow={1} flexShrink={1} height={answerRows} overflowY="hidden">
          <BaseTextInput
            displayWidth={Math.max(1, contentWidth - 2)}
            maxDisplayRows={answerRows}
            value={answer}
            onChange={setAnswer}
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (trimmed.length === 0) {
                props.onDecide({ accepted: false, userMessage: 'cancelled' });
              } else {
                props.onDecide({ accepted: true, userMessage: trimmed });
              }
            }}
          />
        </Box>
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            ...(questionScrollable
              ? [{ key: 'PgUp/PgDn', action: 'question' }]
              : []),
            { key: 'Enter', action: 'submit answer' },
            { key: 'Ctrl-R', action: 'reject with note' },
            { key: 'Esc', action: 'skip' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
