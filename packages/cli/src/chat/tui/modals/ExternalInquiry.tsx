import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';

import { writeClipboardText } from '@cli/runtime/clipboardText';
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WARNING } from '@cli/tui/ui/colors';
import { POINTER } from '@cli/tui/ui/glyphs';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
} from '@cli/tui/ui/theme';
import {
  KEY_HINT_SEPARATOR,
  KeyHints,
  keyHintText,
  type KeyHint,
} from '@cli/tui/ui/KeyHints';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import type { ExternalInquiryPermission } from '@shared/schemas';
import { clamp } from '@utils/core';

import { modalTextDisplayLines } from './ScrollableModalText';
import { BaseTextInput } from '../input/BaseTextInput';
import { isEscapeInput } from '../input/inputKeys';
import {
  moreRowsText,
  previousRowsText,
  scrollStatusText,
} from '../render/overflowText';
import {
  compactAwareMaxScrollOffset,
  scrollBoundedRows,
  type ScrollableDisplayLine,
} from '../render/scrollBounds';
import { textDisplayWidth } from '../render/terminalText';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface ExternalInquiryProps {
  readonly availableRows?: number;
  readonly payload: ExternalInquiryPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

type ExternalInquiryDisplayLine = ScrollableDisplayLine<'text'>;

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

// Measured through the canonical `keyHintText` projection so the fit check
// sees exactly what `KeyHints` renders. Strictly narrower than the budget:
// the footer sits inside the card decoration and must not touch its edge.
function keyHintsFit(hints: readonly KeyHint[], maxColumns: number): boolean {
  return (
    textDisplayWidth(hints.map(keyHintText).join(KEY_HINT_SEPARATOR)) <
    maxColumns
  );
}

export function externalInquiryKeyHintsForWidth({
  maxColumns,
  questionScrollable,
}: {
  readonly maxColumns: number;
  readonly questionScrollable: boolean;
}): readonly KeyHint[] {
  const scrollHint = (action: string, key = 'PgUp/PgDn'): KeyHint[] =>
    questionScrollable ? [{ key, action }] : [];
  const actionHints: readonly KeyHint[] = [
    { key: 'Enter', action: 'submit answer' },
    { key: 'Ctrl-R', action: 'reject with note' },
    { key: 'Esc', action: 'skip' },
  ];
  const compactTailHints: readonly KeyHint[] = [
    { key: 'Ctrl-Y', action: 'copy' },
    { key: 'Enter', action: 'submit' },
    { key: 'Ctrl-R', action: 'reject' },
    { key: 'Esc', action: 'skip' },
  ];

  // Widest layout first; the first one that fits wins.
  const candidates: readonly (readonly KeyHint[])[] = [
    [
      ...scrollHint('question'),
      { key: 'Ctrl-Y', action: 'copy question' },
      ...actionHints,
    ],
    [
      ...scrollHint('scroll'),
      { key: 'Ctrl-Y', action: 'copy' },
      ...actionHints,
    ],
    [...scrollHint('scroll'), ...compactTailHints],
    [...scrollHint('scroll', 'PgUp/Dn'), ...compactTailHints],
    compactTailHints,
    [
      { key: 'Ctrl-Y', action: 'copy' },
      { key: 'Enter', action: 'submit' },
      { key: 'Esc', action: 'skip' },
    ],
  ];
  return (
    candidates.find((hints) => keyHintsFit(hints, maxColumns)) ?? [
      { key: 'Esc', action: 'skip' },
    ]
  );
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
  const lines = modalTextDisplayLines({ text: question, width });
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
      modalTextDisplayLines({
        text: props.payload.question,
        width: contentWidth,
      }).length,
    [contentWidth, props.payload.question],
  );
  const maxQuestionOffset = compactAwareMaxScrollOffset({
    compactRows: COMPACT_EXTERNAL_INQUIRY_QUESTION_ROWS,
    maxDisplayLines: questionRows,
    totalLines: questionLineCount,
  });
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
    // One write in flight at a time: a second Ctrl-Y while a copy is pending
    // would race the first write's timeout reap, which kills all direct-child
    // copy helpers -- including the second attempt's.
    if (copyStatus === 'copying') return;
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
      color={COLOR_SUCCESS}
      width={columns}
      title={
        <>
          Agent asks:
          {copyStatus !== 'idle' ? (
            <Text
              color={copyStatus === 'failed' ? COLOR_ERROR : COLOR_SUCCESS}
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
        <Text>{`${POINTER} `}</Text>
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
