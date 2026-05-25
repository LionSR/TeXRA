import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

import { parseUserQuestionAnswer } from '@cli/runtime/userQuestionAnswer';
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
import { isPlainReturnInput } from '../input/inputKeys';
import { Select } from '../ui/Select';
import { KeyHints, type KeyHint } from '../ui/KeyHints';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface UserQuestionProps {
  readonly payload: UserQuestionPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

function submitDecision(
  onDecide: (decision: ApprovalDecision) => void,
  answers: UserQuestionAnswers,
): void {
  onDecide(userQuestionDecision(answers));
}

interface QuestionShellProps {
  readonly payload: UserQuestionPermission;
  readonly question: UserQuestionPrompt;
  readonly index: number;
  readonly children: React.ReactNode;
  readonly hints: readonly KeyHint[];
}

function QuestionShell(props: QuestionShellProps): React.JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor="green"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="green">
        Agent asks:
      </Text>
      {props.payload.context ? (
        <Box marginTop={1}>
          <Text dimColor>{props.payload.context}</Text>
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text>
          {props.payload.questions.length > 1
            ? `${props.index + 1}/${props.payload.questions.length} `
            : ''}
          {props.question.question}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {props.children}
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={props.hints} confirmCancel={false} />
      </Box>
    </Box>
  );
}

interface MultiSelectQuestionProps {
  readonly payload: UserQuestionPermission;
  readonly question: UserQuestionPrompt;
  readonly index: number;
  readonly onSubmit: (answer: string[]) => void;
  readonly onCancel: () => void;
}

function MultiSelectQuestion(
  props: MultiSelectQuestionProps,
): React.JSX.Element {
  const [highlight, setHighlight] = useState(0);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const options = props.question.options;

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) {
      props.onCancel();
      return;
    }
    if (key.upArrow) {
      setHighlight((h) => (h <= 0 ? options.length - 1 : h - 1));
      return;
    }
    if (key.downArrow) {
      setHighlight((h) => (h + 1) % options.length);
      return;
    }
    if (input === ' ') {
      const option = options[highlight];
      if (option) {
        setSelected((s) => toggleUserQuestionSelection(s, option.label));
      }
      return;
    }
    if (isPlainReturnInput(input, key)) {
      props.onSubmit([...selected]);
      return;
    }
    const digit = Number(input);
    if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
      const index = digit - 1;
      const option = options[index];
      setHighlight(index);
      if (option) {
        setSelected((s) => toggleUserQuestionSelection(s, option.label));
      }
    }
  });

  return (
    <QuestionShell
      payload={props.payload}
      question={props.question}
      index={props.index}
      hints={[
        { key: 'Space', action: 'toggle' },
        { key: 'Enter', action: 'submit' },
        { key: 'Esc', action: 'skip' },
      ]}
    >
      {options.map((option, optionIndex) => {
        const focused = optionIndex === highlight;
        const checked = selected.includes(option.label);
        return (
          <Box key={option.label}>
            <Text color={focused ? 'cyan' : undefined}>
              {focused ? '›' : ' '} {checked ? '✓' : ' '} {optionIndex + 1}
              .{' '}
            </Text>
            <Text color={focused ? 'cyan' : undefined}>{option.label}</Text>
            {option.description ? (
              <Text dimColor>{` — ${option.description}`}</Text>
            ) : null}
          </Box>
        );
      })}
    </QuestionShell>
  );
}

interface FreeTextQuestionProps {
  readonly payload: UserQuestionPermission;
  readonly question: UserQuestionPrompt;
  readonly index: number;
  readonly onSubmit: (answer: string | string[] | undefined) => void;
  readonly onCancel: () => void;
}

function FreeTextQuestion(props: FreeTextQuestionProps): React.JSX.Element {
  const [answer, setAnswer] = useState('');
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) {
      props.onCancel();
    }
  });

  return (
    <QuestionShell
      payload={props.payload}
      question={props.question}
      index={props.index}
      hints={[
        { key: 'Enter', action: 'submit answer' },
        { key: 'Esc', action: 'skip' },
      ]}
    >
      <Box flexDirection="column">
        {props.question.options.map((option, optionIndex) => (
          <Text key={option.label} dimColor>
            {optionIndex + 1}. {option.label}
            {option.description ? ` — ${option.description}` : ''}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text>{'> '}</Text>
        <BaseTextInput
          value={answer}
          onChange={setAnswer}
          onSubmit={(value) =>
            props.onSubmit(parseUserQuestionAnswer(value, props.question))
          }
        />
      </Box>
    </QuestionShell>
  );
}

interface SingleSelectQuestionProps {
  readonly payload: UserQuestionPermission;
  readonly question: UserQuestionPrompt;
  readonly index: number;
  readonly onSubmit: (answer: string) => void;
  readonly onCancel: () => void;
}

function SingleSelectQuestion(
  props: SingleSelectQuestionProps,
): React.JSX.Element {
  return (
    <QuestionShell
      payload={props.payload}
      question={props.question}
      index={props.index}
      hints={[
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

  const cancel = () =>
    props.onDecide({
      accepted: false,
      userMessage: USER_QUESTION_SKIPPED_FEEDBACK,
    });

  const submitAnswer = (answer: string | string[] | undefined) => {
    if (!question) {
      submitDecision(props.onDecide, answers);
      return;
    }
    const nextAnswers = updateUserQuestionAnswers(answers, question, answer);
    if (index + 1 >= props.payload.questions.length) {
      submitDecision(props.onDecide, nextAnswers);
      return;
    }
    setAnswers(nextAnswers);
    setIndex(index + 1);
  };

  if (!question) {
    return <Text />;
  }

  if (question.multiSelect) {
    return (
      <MultiSelectQuestion
        payload={props.payload}
        question={question}
        index={index}
        onSubmit={submitAnswer}
        onCancel={cancel}
      />
    );
  }

  if (question.allowFreeText) {
    return (
      <FreeTextQuestion
        payload={props.payload}
        question={question}
        index={index}
        onSubmit={submitAnswer}
        onCancel={cancel}
      />
    );
  }

  return (
    <SingleSelectQuestion
      payload={props.payload}
      question={question}
      index={index}
      onSubmit={submitAnswer}
      onCancel={cancel}
    />
  );
}
