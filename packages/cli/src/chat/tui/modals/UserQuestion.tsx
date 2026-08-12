import { useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';

import { parseUserQuestionAnswer } from '@cli/runtime/userQuestionAnswer';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import { isEscapeInput } from '@cli/tui/inputKeys';
import {
  previousRowsText,
  selectVisibleInlineOverflowText,
} from '@cli/tui/overflowText';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import { KeyHints, type KeyHint } from '@cli/tui/ui/KeyHints';
import { Select } from '@cli/tui/ui/Select';
import { COLOR_SUCCESS } from '@cli/tui/ui/colors';
import { POINTER } from '@cli/tui/ui/glyphs';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
  isCompactRows,
} from '@cli/tui/ui/theme';
import type {
  UserQuestionAnswers,
  UserQuestionPermission,
  UserQuestionPrompt,
} from '@shared/schemas';

import {
  toggleUserQuestionSelection,
  updateUserQuestionAnswers,
  USER_QUESTION_SKIPPED_FEEDBACK,
  userQuestionDecision,
} from './UserQuestionState';
import { BaseTextInput } from '../input/BaseTextInput';
import { clipToWidth, textDisplayWidth } from '../render/terminalText';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface UserQuestionProps {
  readonly availableRows?: number;
  readonly payload: UserQuestionPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

export interface UserQuestionPromptLine {
  readonly kind: 'context' | 'question' | 'overflow';
  readonly text: string;
}

const DEFAULT_USER_QUESTION_PROMPT_ROWS = 12;
const COMPACT_USER_QUESTION_MAX_ROWS = 10;
const COMPACT_USER_QUESTION_CHROME_ROWS = 4;
const FULL_USER_QUESTION_CHROME_ROWS = 7;

type UserQuestionOption = UserQuestionPrompt['options'][number];

function wrappedUserQuestionPromptLines({
  kind,
  text,
  width,
}: {
  readonly kind: UserQuestionPromptLine['kind'];
  readonly text: string;
  readonly width: number;
}): UserQuestionPromptLine[] {
  return text.split('\n').flatMap((line) =>
    wrapAnsiToWidth(line, width)
      .split('\n')
      .map((wrapped): UserQuestionPromptLine => ({ kind, text: wrapped })),
  );
}

function userQuestionInlineClipIndicator({
  hiddenRows,
  line,
  width,
}: {
  readonly hiddenRows: number;
  readonly line: UserQuestionPromptLine;
  readonly width: number;
}): UserQuestionPromptLine {
  const prefix = `… ${hiddenRows} clipped rows - `;
  const clippedPrefix = clipToWidth(prefix, width);
  const remainingWidth = Math.max(0, width - textDisplayWidth(clippedPrefix));
  if (remainingWidth <= 0) return { kind: 'overflow', text: clippedPrefix };
  return {
    ...line,
    text: `${clippedPrefix}${clipToWidth(line.text, remainingWidth)}`,
  };
}

function userQuestionChoiceHints({
  optionCount,
  shortcutAction,
}: {
  readonly optionCount: number;
  readonly shortcutAction: string;
}): KeyHint[] {
  return [
    { key: '↑/↓', action: 'navigate' },
    { key: `1-${optionCount}`, action: shortcutAction },
  ];
}

export function isCompactUserQuestionRows(
  availableRows: number | undefined,
): boolean {
  return isCompactRows(availableRows, COMPACT_USER_QUESTION_MAX_ROWS);
}

export function userQuestionChoiceRowsBudget({
  availableRows,
  optionCount,
}: {
  readonly availableRows?: number;
  readonly optionCount: number;
}): number {
  if (optionCount <= 0) return 0;
  if (availableRows === undefined) return optionCount;
  const compact = isCompactUserQuestionRows(availableRows);
  const chromeRows = compact
    ? COMPACT_USER_QUESTION_CHROME_ROWS
    : FULL_USER_QUESTION_CHROME_ROWS;
  const answerRows = Math.max(0, availableRows - chromeRows);
  const maxRows = compact
    ? Math.min(1, answerRows)
    : Math.max(0, answerRows - 2);
  return Math.min(optionCount, maxRows);
}

export function userQuestionFreeTextOptionRowsBudget({
  availableRows,
  optionCount,
}: {
  readonly availableRows?: number;
  readonly optionCount: number;
}): number {
  if (optionCount <= 0) return 0;
  if (availableRows === undefined) return optionCount;
  if (isCompactUserQuestionRows(availableRows)) return 0;
  return Math.min(
    optionCount,
    Math.max(0, availableRows - FULL_USER_QUESTION_CHROME_ROWS - 4),
  );
}

export function userQuestionFreeTextControlRows(optionRows: number): number {
  return optionRows + 1 + (optionRows > 0 ? 1 : 0);
}

export function userQuestionPromptRowsBudget({
  availableRows,
  controlRows,
}: {
  readonly availableRows?: number;
  readonly controlRows: number;
}): number {
  if (availableRows === undefined) return DEFAULT_USER_QUESTION_PROMPT_ROWS;
  const chromeRows = isCompactUserQuestionRows(availableRows)
    ? COMPACT_USER_QUESTION_CHROME_ROWS
    : FULL_USER_QUESTION_CHROME_ROWS;
  return Math.max(0, availableRows - chromeRows - controlRows);
}

export function userQuestionFreeTextSuggestionLine({
  option,
  optionIndex,
  overflowText,
  width,
}: {
  readonly option: UserQuestionOption;
  readonly optionIndex: number;
  readonly overflowText?: string;
  readonly width: number;
}): string {
  const prefix = `${optionIndex + 1}. ${option.label}`;
  if (overflowText) {
    const suffix = ` — ${overflowText}`;
    const prefixWidth = width - textDisplayWidth(suffix);
    if (prefixWidth <= 0) return clipToWidth(suffix, width);
    return `${clipToWidth(prefix, prefixWidth).trimEnd()}${suffix}`;
  }
  const suffix = option.description ? ` — ${option.description}` : '';
  return clipToWidth(`${prefix}${suffix}`, width);
}

export function boundedUserQuestionPromptLines({
  context,
  maxDisplayLines,
  question,
  width,
}: {
  readonly context?: string | null;
  readonly maxDisplayLines: number;
  readonly question: string;
  readonly width: number;
}): readonly UserQuestionPromptLine[] {
  if (maxDisplayLines <= 0) return [];
  const wrapWidth = clampModalWidth(width);
  const contextLines = context
    ? wrappedUserQuestionPromptLines({
        kind: 'context',
        text: context,
        width: wrapWidth,
      })
    : [];
  const questionLines = wrappedUserQuestionPromptLines({
    kind: 'question',
    text: question,
    width: wrapWidth,
  });
  const lines = [...contextLines, ...questionLines];
  if (lines.length <= maxDisplayLines) return lines;

  if (questionLines.length >= maxDisplayLines) {
    const visibleQuestionLines = questionLines.slice(0, maxDisplayLines);
    const hiddenRows =
      contextLines.length + questionLines.length - visibleQuestionLines.length;
    if (hiddenRows <= 0) return visibleQuestionLines;
    return [
      userQuestionInlineClipIndicator({
        hiddenRows,
        line: visibleQuestionLines[0] ?? {
          kind: 'overflow',
          text: '',
        },
        width: wrapWidth,
      }),
      ...visibleQuestionLines.slice(1),
    ];
  }

  const availableContextRows = maxDisplayLines - questionLines.length;
  const visibleContextLines =
    availableContextRows === 1
      ? []
      : contextLines.slice(-(availableContextRows - 1));
  const hiddenBefore = Math.max(
    0,
    contextLines.length - visibleContextLines.length,
  );
  return [
    ...(hiddenBefore > 0
      ? [
          {
            kind: 'overflow' as const,
            text: previousRowsText(hiddenBefore),
          },
        ]
      : []),
    ...visibleContextLines,
    ...questionLines,
  ];
}

interface QuestionVariantProps {
  readonly availableRows?: number;
  readonly payload: UserQuestionPermission;
  readonly question: UserQuestionPrompt;
  readonly index: number;
  readonly onSubmit: (answer: string | string[] | undefined) => void;
  readonly onCancel: () => void;
}

interface QuestionShellProps extends Omit<
  QuestionVariantProps,
  'onSubmit' | 'onCancel'
> {
  readonly controlRows: number;
  readonly children: React.ReactNode;
  readonly hints: readonly KeyHint[];
}

function QuestionShell(props: QuestionShellProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const compact = isCompactUserQuestionRows(props.availableRows);
  const contentWidth = clampModalWidth(
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const promptRows = userQuestionPromptRowsBudget({
    availableRows: props.availableRows,
    controlRows: props.controlRows,
  });
  const questionText = `${
    props.payload.questions.length > 1
      ? `${props.index + 1}/${props.payload.questions.length} `
      : ''
  }${props.question.question}`;
  const promptLines = useMemo(
    () =>
      boundedUserQuestionPromptLines({
        context: props.payload.context,
        maxDisplayLines: promptRows,
        question: questionText,
        width: contentWidth,
      }),
    [contentWidth, promptRows, props.payload.context, questionText],
  );
  return (
    <BorderedPanel
      borderStyle="single"
      color={COLOR_SUCCESS}
      width={columns}
      title="Agent asks:"
      footer={<KeyHints hints={props.hints} confirmCancel={false} />}
      footerMarginTop={compact ? 0 : 1}
    >
      <Box marginTop={compact ? 0 : 1} flexDirection="column">
        {promptLines.map((line, lineIndex) => (
          <Text
            key={lineIndex}
            dimColor={line.kind === 'context' || line.kind === 'overflow'}
          >
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      <Box marginTop={compact ? 0 : 1} flexDirection="column">
        {props.children}
      </Box>
    </BorderedPanel>
  );
}

function MultiSelectQuestion(props: QuestionVariantProps): React.JSX.Element {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const options = props.question.options;
  const maxVisibleOptions = userQuestionChoiceRowsBudget({
    availableRows: props.availableRows,
    optionCount: options.length,
  });
  const selectedValues = useMemo(() => new Set(selected), [selected]);

  return (
    <QuestionShell
      availableRows={props.availableRows}
      controlRows={maxVisibleOptions}
      payload={props.payload}
      question={props.question}
      index={props.index}
      hints={[
        ...userQuestionChoiceHints({
          optionCount: options.length,
          shortcutAction: 'toggle',
        }),
        { key: 'Space', action: 'toggle' },
        { key: 'Enter', action: 'submit' },
        { key: 'Esc', action: 'skip' },
      ]}
    >
      <Select
        mode="multi"
        items={options.map((option) => ({
          value: option.label,
          label: option.label,
          description: option.description ?? undefined,
        }))}
        maxVisibleItems={maxVisibleOptions}
        selectedValues={selectedValues}
        onToggle={(label) =>
          setSelected((s) => toggleUserQuestionSelection(s, label))
        }
        onSelect={() => props.onSubmit([...selected])}
        onCancel={props.onCancel}
      />
    </QuestionShell>
  );
}

function FreeTextQuestion(props: QuestionVariantProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [answer, setAnswer] = useState('');
  const contentWidth = clampModalWidth(
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const optionRows = userQuestionFreeTextOptionRowsBudget({
    availableRows: props.availableRows,
    optionCount: props.question.options.length,
  });
  const visibleOptions = props.question.options.slice(0, optionRows);
  const inlineOverflowText = selectVisibleInlineOverflowText({
    hiddenAfter: props.question.options.length - visibleOptions.length,
    hiddenBefore: 0,
    showOverflow: false,
    visibleItemCount: visibleOptions.length,
  });
  useInput((input, key) => {
    // Esc cancels; App clears a non-empty answer before applying its usual
    // Ctrl+C stop or exit behavior.
    if (isEscapeInput(input, key)) {
      props.onCancel();
    }
  });

  return (
    <QuestionShell
      availableRows={props.availableRows}
      controlRows={userQuestionFreeTextControlRows(optionRows)}
      payload={props.payload}
      question={props.question}
      index={props.index}
      hints={[
        { key: 'Enter', action: 'submit answer' },
        { key: 'Esc', action: 'skip' },
      ]}
    >
      <Box flexDirection="column">
        {visibleOptions.map((option, optionIndex) => (
          <Text key={option.label} dimColor wrap="truncate-end">
            {userQuestionFreeTextSuggestionLine({
              option,
              optionIndex,
              overflowText:
                optionIndex === visibleOptions.length - 1
                  ? inlineOverflowText
                  : undefined,
              width: contentWidth,
            })}
          </Text>
        ))}
      </Box>
      <Box marginTop={optionRows > 0 ? 1 : 0}>
        <Text>{`${POINTER} `}</Text>
        <Box flexGrow={1} flexShrink={1} height={1} overflowY="hidden">
          <BaseTextInput
            displayWidth={Math.max(1, contentWidth - 2)}
            maxDisplayRows={1}
            value={answer}
            onChange={setAnswer}
            onSubmit={(value) =>
              props.onSubmit(parseUserQuestionAnswer(value, props.question))
            }
          />
        </Box>
      </Box>
    </QuestionShell>
  );
}

function SingleSelectQuestion(props: QuestionVariantProps): React.JSX.Element {
  const optionRows = userQuestionChoiceRowsBudget({
    availableRows: props.availableRows,
    optionCount: props.question.options.length,
  });
  return (
    <QuestionShell
      availableRows={props.availableRows}
      controlRows={optionRows}
      payload={props.payload}
      question={props.question}
      index={props.index}
      hints={[
        ...userQuestionChoiceHints({
          optionCount: props.question.options.length,
          shortcutAction: 'select now',
        }),
        { key: 'Enter', action: 'select' },
        { key: 'Esc', action: 'skip' },
      ]}
    >
      <Select
        items={props.question.options.map((option) => ({
          value: option.label,
          label: option.label,
          description: option.description ?? undefined,
        }))}
        maxVisibleItems={optionRows}
        onSelect={props.onSubmit}
        onCancel={props.onCancel}
      />
    </QuestionShell>
  );
}

export function UserQuestion(props: UserQuestionProps): React.JSX.Element {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<UserQuestionAnswers>({});
  const question = props.payload.questions[index];

  function cancel(): void {
    props.onDecide({
      accepted: false,
      userMessage: USER_QUESTION_SKIPPED_FEEDBACK,
    });
  }

  function submitAnswer(answer: string | string[] | undefined): void {
    if (!question) {
      props.onDecide(userQuestionDecision(answers));
      return;
    }
    const nextAnswers = updateUserQuestionAnswers(answers, question, answer);
    if (index + 1 >= props.payload.questions.length) {
      props.onDecide(userQuestionDecision(nextAnswers));
      return;
    }
    setAnswers(nextAnswers);
    setIndex(index + 1);
  }

  if (!question) return <Text />;

  const variantProps: QuestionVariantProps = {
    availableRows: props.availableRows,
    payload: props.payload,
    question,
    index,
    onSubmit: submitAnswer,
    onCancel: cancel,
  };

  if (question.multiSelect) return <MultiSelectQuestion {...variantProps} />;
  if (question.allowFreeText) return <FreeTextQuestion {...variantProps} />;
  return <SingleSelectQuestion {...variantProps} />;
}
