import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';

import { writeClipboardText } from '@cli/runtime/clipboardText';
import type { ExternalInquiryPermission } from '@shared/schemas';
import { clamp } from '@utils/core';

import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
} from '../ui/theme';
import { BaseTextInput } from '../input/BaseTextInput';
import { isEscapeInput } from '../input/inputKeys';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import {
  moreRowsText,
  previousRowsText,
  scrollStatusText,
} from '../render/overflowText';
import {
  maxScrollableRowOffset,
  scrollBoundedRows,
} from '../render/scrollBounds';
import { KEY_HINT_SEPARATOR, KeyHints, type KeyHint } from '../ui/KeyHints';
import { BorderedPanel } from '../ui/BorderedPanel';
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

type CopyStatus = 'idle' | 'copying' | 'copied' | 'failed';

function copyStatusLabel(status: Exclude<CopyStatus, 'idle'>): string {
  switch (status) {
    case 'copying':
      return ' copying...';
    case 'copied':
      return ' copied to clipboard';
    case 'failed':
      return ' copy failed';
  }
}

const DEFAULT_EXTERNAL_INQUIRY_QUESTION_ROWS = 16;
const COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS = 3;
const EXTERNAL_INQUIRY_FIXED_ROWS = 6;

function keyHintsColumns(hints: readonly KeyHint[]): number {
  return hints.reduce(
    (width, hint, index) =>
      width +
      (index === 0 ? 0 : KEY_HINT_SEPARATOR.length) +
      hint.key.length +
      1 +
      hint.action.length,
    0,
  );
}

function keyHintsFit(hints: readonly KeyHint[], maxColumns: number): boolean {
  return keyHintsColumns(hints) < maxColumns;
}

export function externalInquiryKeyHintsForWidth({
  maxColumns,
  questionScrollable,
}: {
  readonly maxColumns: number;
  readonly questionScrollable: boolean;
}): readonly KeyHint[] {
  const actionHints: readonly KeyHint[] = [
    { key: 'Enter', action: 'submit answer' },
    { key: 'Ctrl-R', action: 'reject with note' },
    { key: 'Esc', action: 'skip' },
  ];
  const fullHints = [
    ...(questionScrollable ? [{ key: 'PgUp/PgDn', action: 'question' }] : []),
    { key: 'Ctrl-Y', action: 'copy question' },
    ...actionHints,
  ];
  if (keyHintsFit(fullHints, maxColumns)) return fullHints;

  const compactScrollHints = [
    ...(questionScrollable ? [{ key: 'PgUp/PgDn', action: 'scroll' }] : []),
    { key: 'Ctrl-Y', action: 'copy' },
    ...actionHints,
  ];
  if (keyHintsFit(compactScrollHints, maxColumns)) return compactScrollHints;

  const compactTailHints: readonly KeyHint[] = [
    { key: 'Ctrl-Y', action: 'copy' },
    { key: 'Enter', action: 'submit' },
    { key: 'Ctrl-R', action: 'reject' },
    { key: 'Esc', action: 'skip' },
  ];
  const compactAllHints = [
    ...(questionScrollable ? [{ key: 'PgUp/PgDn', action: 'scroll' }] : []),
    ...compactTailHints,
  ];
  if (keyHintsFit(compactAllHints, maxColumns)) return compactAllHints;

  const shortScrollHints = [
    ...(questionScrollable ? [{ key: 'PgUp/Dn', action: 'scroll' }] : []),
    ...compactTailHints,
  ];
  if (keyHintsFit(shortScrollHints, maxColumns)) return shortScrollHints;

  if (keyHintsFit(compactTailHints, maxColumns)) return compactTailHints;

  const minimumHints: readonly KeyHint[] = [
    { key: 'Ctrl-Y', action: 'copy' },
    { key: 'Enter', action: 'submit' },
    { key: 'Esc', action: 'skip' },
  ];
  return keyHintsFit(minimumHints, maxColumns)
    ? minimumHints
    : [{ key: 'Esc', action: 'skip' }];
}

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
  return Math.max(0, availableRows - EXTERNAL_INQUIRY_FIXED_ROWS - answerRows);
}

function externalInquiryQuestionLines({
  question,
  width,
}: {
  readonly question: string;
  readonly width: number;
}): ExternalInquiryDisplayLine[] {
  const questionWidth = clampModalWidth(width);
  return question.split('\n').flatMap((line) =>
    wrapAnsiToWidth(line, questionWidth)
      .split('\n')
      .map((text): ExternalInquiryDisplayLine => ({ kind: 'question', text })),
  );
}

function maxExternalInquiryQuestionScrollOffset(
  totalLines: number,
  maxDisplayLines: number,
): number {
  if (maxDisplayLines <= 0) return 0;
  if (totalLines <= maxDisplayLines) return 0;
  if (maxDisplayLines <= COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS) {
    return Math.max(0, totalLines - Math.max(1, maxDisplayLines - 1));
  }
  return maxScrollableRowOffset({
    compactRows: COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS,
    maxDisplayLines,
    totalLines,
  });
}

function overflowLine(text: string): ExternalInquiryDisplayLine {
  return { kind: 'overflow', text };
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
  if (maxDisplayLines <= 0) return [];
  if (lines.length <= maxDisplayLines) return lines;

  if (maxDisplayLines <= COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS) {
    const visibleCount = Math.max(1, maxDisplayLines - 1);
    const offset = clamp(
      scrollOffset,
      0,
      Math.max(0, lines.length - visibleCount),
    );
    const visible = lines.slice(offset, offset + visibleCount);
    const hiddenBefore = offset;
    const hiddenAfter = Math.max(0, lines.length - (offset + visible.length));
    if (maxDisplayLines === 1) return visible;
    return [
      ...visible,
      ...(hiddenBefore > 0 || hiddenAfter > 0
        ? [overflowLine(scrollStatusText(hiddenBefore, hiddenAfter))]
        : []),
    ];
  }

  const { hiddenAfter, hiddenBefore, visibleRows } = scrollBoundedRows({
    compactRows: COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS,
    maxDisplayLines,
    rows: lines,
    scrollOffset,
  });

  return [
    ...(hiddenBefore > 0 ? [overflowLine(previousRowsText(hiddenBefore))] : []),
    ...visibleRows,
    ...(hiddenAfter > 0 ? [overflowLine(moreRowsText(hiddenAfter))] : []),
  ];
}

export function ExternalInquiry(
  props: ExternalInquiryProps,
): React.JSX.Element {
  const { columns } = useWindowSize();
  const [answer, setAnswer] = useState('');
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const [questionOffset, setQuestionOffset] = useState(0);
  const contentWidth = clampModalWidth(
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
  const keyHints = externalInquiryKeyHintsForWidth({
    maxColumns: contentWidth,
    questionScrollable,
  });

  function scrollQuestion(next: (currentOffset: number) => number): void {
    setQuestionOffset((current) => clamp(next(current), 0, maxQuestionOffset));
  }

  async function copyQuestion(): Promise<void> {
    setCopyStatus('copying');
    const result = await writeClipboardText(props.payload.question);
    if (result.ok) {
      setCopyStatus('copied');
      return;
    }
    setCopyStatus('failed');
  }

  useEffect(() => {
    setQuestionOffset((current) => clamp(current, 0, maxQuestionOffset));
  }, [maxQuestionOffset]);

  useInput((input, key) => {
    if (isEscapeInput(input, key)) {
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
    if (key.ctrl && input.toLowerCase() === 'y') {
      void copyQuestion();
      return;
    }
    if (key.pageDown) {
      scrollQuestion((current) => current + pageRows);
      return;
    }
    if (key.pageUp) {
      scrollQuestion((current) => current - pageRows);
      return;
    }
  });

  return (
    <BorderedPanel
      borderStyle="single"
      color="green"
      width={columns}
      title={
        <>
          Agent asks:
          {copyStatus !== 'idle' ? (
            <Text
              color={copyStatus === 'failed' ? 'yellow' : 'green'}
              dimColor={copyStatus === 'copying'}
            >
              {copyStatusLabel(copyStatus)}
            </Text>
          ) : null}
        </>
      }
      footer={<KeyHints hints={keyHints} confirmCancel={false} />}
    >
      <Box flexDirection="column">
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
    </BorderedPanel>
  );
}
