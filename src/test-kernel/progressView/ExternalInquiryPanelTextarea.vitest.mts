// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { ExternalInquiryPanel } from '@progressView/frontend/components/ExternalInquiryPanel';

// Local imports - shared schemas
import type { ExternalInquiryPermission } from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

function createPermission(
  overrides: Partial<ExternalInquiryPermission> = {},
): ExternalInquiryPanel['permission'] {
  return {
    kind: 'externalInquiry',
    data: {
      requestId: 'inquiry-1',
      allowBypass: false,
      streamId: 'stream-1',
      threadId: 'ei_000000000000',
      question: 'What is the answer?',
      mode: 'new',
      ...overrides,
    },
  };
}

async function mountPanel(
  permission: ExternalInquiryPanel['permission'] = createPermission(),
): Promise<ExternalInquiryPanel> {
  const element = document.createElement(
    'external-inquiry-panel',
  ) as ExternalInquiryPanel;
  element.permission = permission;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function recordPermissionActions(
  element: ExternalInquiryPanel,
): Record<string, unknown>[] {
  const actions: Record<string, unknown>[] = [];
  element.addEventListener('permission-action', (event) => {
    actions.push((event as CustomEvent<Record<string, unknown>>).detail);
  });
  return actions;
}

function setTextareaValue(textarea: HTMLElement, value: string): void {
  (textarea as HTMLElement & { value: string }).value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('external-inquiry-panel answer/session-link inputs', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/ExternalInquiryPanel'),
  );

  it('renders wa-textarea for the answer and session-link inputs, never a native textarea', async () => {
    const element = await mountPanel();

    expect(element.shadowRoot!.querySelector('textarea')).toBeNull();
    expect(
      element.shadowRoot!.querySelectorAll('wa-textarea').length,
    ).toBe(2);
    expect(
      element.shadowRoot!.querySelector(
        '.external-inquiry-request__answer-input',
      )?.tagName.toLowerCase(),
    ).toBe('wa-textarea');
    expect(
      element.shadowRoot!.querySelector(
        '.external-inquiry-request__session-links-input',
      )?.tagName.toLowerCase(),
    ).toBe('wa-textarea');
  });

  it('reads the wa-textarea shadow-DOM value on input and submits it as the answer', async () => {
    const element = await mountPanel();
    const actions = recordPermissionActions(element);

    const answerInput = element.shadowRoot!.querySelector(
      '.external-inquiry-request__answer-input',
    ) as HTMLElement;
    const submitButton = element.shadowRoot!.querySelector(
      'wa-button[data-action="submit"]',
    ) as HTMLElement & { disabled?: boolean };

    expect(submitButton.disabled).toBe(true);

    setTextareaValue(answerInput, '  the answer  ');
    await element.updateComplete;

    expect(submitButton.disabled).toBe(false);

    const sessionLinksInput = element.shadowRoot!.querySelector(
      '.external-inquiry-request__session-links-input',
    ) as HTMLElement;
    setTextareaValue(
      sessionLinksInput,
      'https://chatgpt.com/c/abc\nhttps://chatgpt.com/c/abc\n',
    );
    await element.updateComplete;

    submitButton.click();

    expect(actions).toEqual([
      {
        permission: element.permission,
        action: 'submit',
        answer: 'the answer',
        sessionLinks: ['https://chatgpt.com/c/abc'],
      },
    ]);
  });
});
