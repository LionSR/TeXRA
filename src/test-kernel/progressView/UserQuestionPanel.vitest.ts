import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import type { UserQuestionPanel } from '@progressView/frontend/components/UserQuestionPanel';
import { RunIdSchema } from '@shared/schemas';
import type { UserQuestionPrompt } from '@shared/schemas';
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/UserQuestionPanel'),
);

const RUN_ID = Schema.decodeUnknownSync(RunIdSchema)('aaaaaaaaaaaa');

function createPermission(
  questions: UserQuestionPrompt[] = [
    {
      question: 'Choose an answer',
      options: [{ label: 'A' }, { label: 'B' }],
      allowFreeText: true,
    },
  ],
): UserQuestionPanel['permission'] {
  return {
    kind: 'userQuestion',
    data: {
      requestId: 'question-1',
      allowBypass: false,
      runId: RUN_ID,
      questions,
    },
  };
}

function mountPanel(
  permission: UserQuestionPanel['permission'] = createPermission(),
): Promise<UserQuestionPanel> {
  return mountComponent<UserQuestionPanel>('user-question-panel', {
    permission,
  });
}

type Decision = { action: string; answers?: Record<string, string | string[]> };

function collectActions(element: UserQuestionPanel): Decision[] {
  const actions: Decision[] = [];
  element.addEventListener('runtime-request', (event) => {
    actions.push(
      (event as CustomEvent<{ decision: Decision }>).detail.decision,
    );
  });
  return actions;
}

function submitButton(
  element: UserQuestionPanel,
): HTMLElement & { disabled?: boolean } {
  const button = element.shadowRoot?.querySelector(
    'wa-button[data-action="primary"]',
  );
  if (!button) throw new Error('submit button not rendered');
  return button as HTMLElement & { disabled?: boolean };
}

function dispatchChange(element: HTMLElement): void {
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

describe('user-question-panel', () => {
  it('does not submit an empty answer set', async () => {
    const element = await mountPanel();
    const actions = collectActions(element);

    expect(submitButton(element).disabled).toBe(false);
    expect(element.handleKeyboardShortcut('y')).toBe(true);
    expect(actions).toEqual([]);
  });

  it('appends multi-select free text to the checked options instead of replacing them', async () => {
    const element = await mountPanel(
      createPermission([
        {
          question: 'Pick any',
          options: [{ label: 'Red' }, { label: 'Blue' }],
          multiSelect: true,
          allowFreeText: true,
        },
      ]),
    );

    const [red] = [
      ...(element.shadowRoot?.querySelectorAll('wa-checkbox') ?? []),
    ] as (HTMLElement & { checked?: boolean })[];
    red.checked = true;
    dispatchChange(red);
    const textarea = element.shadowRoot?.querySelector('wa-textarea') as
      (HTMLElement & { value?: string }) | null;
    if (!textarea) throw new Error('free-text box not rendered');
    textarea.value = ' Purple ';
    textarea.dispatchEvent(
      new Event('input', { bubbles: true, composed: true }),
    );
    await element.updateComplete;

    const actions = collectActions(element);
    element.handleKeyboardShortcut('y');
    expect(actions).toEqual([
      { action: 'submit', answers: { 'Pick any': ['Red', 'Purple'] } },
    ]);
  });
});
