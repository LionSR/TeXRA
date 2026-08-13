import { describe, expect, it } from 'vitest';
import type { UserQuestionPanel } from '@progressView/frontend/components/UserQuestionPanel';
import type { UserQuestionPrompt } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/UserQuestionPanel'),
);

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
    kind: PERMISSION_KIND.USER_QUESTION,
    data: {
      requestId: 'question-1',
      allowBypass: false,
      streamId: 'stream-1',
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
  element.addEventListener('permission-action', (event) => {
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
    'wa-button[data-action="submit"]',
  );
  if (!button) throw new Error('submit button not rendered');
  return button as HTMLElement & { disabled?: boolean };
}

function dispatchChange(element: HTMLElement): void {
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

describe('user-question-panel', () => {
  it('does not emit inherited approve action while rejection feedback is open', async () => {
    const element = await mountPanel();
    const actions = collectActions(element);

    expect(element.handleKeyboardShortcut('n')).toBe(true);
    await element.updateComplete;

    expect(element.handleKeyboardShortcut('y')).toBe(false);
    expect(actions).toEqual([]);
  });

  it('does not submit an empty answer set', async () => {
    const element = await mountPanel();
    const actions = collectActions(element);

    expect(submitButton(element).disabled).toBe(true);
    expect(element.handleKeyboardShortcut('y')).toBe(true);
    expect(actions).toEqual([]);
  });

  it('renders multi-select options as wa-checkbox and accumulates checked labels', async () => {
    const element = await mountPanel(
      createPermission([
        {
          question: 'Pick any',
          options: [{ label: 'Red' }, { label: 'Blue' }],
          multiSelect: true,
        },
      ]),
    );

    const checkboxes = element.shadowRoot?.querySelectorAll('wa-checkbox');
    expect(checkboxes?.length).toBe(2);
    expect(element.shadowRoot?.querySelector('input[type="checkbox"]')).toBe(
      null,
    );

    const [red, blue] = [...(checkboxes ?? [])] as (HTMLElement & {
      checked?: boolean;
    })[];
    red.checked = true;
    dispatchChange(red);
    blue.checked = true;
    dispatchChange(blue);
    await element.updateComplete;

    expect(submitButton(element).disabled).toBe(false);

    const actions = collectActions(element);
    element.handleKeyboardShortcut('y');
    expect(actions).toEqual([
      { action: 'submit', answers: { 'Pick any': ['Red', 'Blue'] } },
    ]);
  });

  it('renders single-select options as wa-radio-group/wa-radio with no native inputs', async () => {
    const element = await mountPanel(
      createPermission([
        {
          question: 'Pick one',
          options: [{ label: 'Yes' }, { label: 'No' }],
          multiSelect: false,
        },
      ]),
    );

    expect(element.shadowRoot?.querySelector('wa-radio-group')).not.toBe(null);
    expect(element.shadowRoot?.querySelectorAll('wa-radio').length).toBe(2);
    expect(element.shadowRoot?.querySelector('input[type="radio"]')).toBe(null);

    const radioGroup = element.shadowRoot?.querySelector(
      'wa-radio-group',
    ) as HTMLElement & { value?: string };
    radioGroup.value = 'No';
    dispatchChange(radioGroup);
    await element.updateComplete;

    const actions = collectActions(element);
    element.handleKeyboardShortcut('y');
    expect(actions).toEqual([
      { action: 'submit', answers: { 'Pick one': 'No' } },
    ]);
  });
});
