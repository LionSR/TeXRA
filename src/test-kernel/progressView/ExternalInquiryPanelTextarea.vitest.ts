// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { ExternalInquiryPanel } from '@progressView/frontend/components/ExternalInquiryPanel';
import { HOST_BRIDGE_API_KEY } from '@shared/hostBridgeTypes';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ExternalInquiryPermission } from '@shared/schemas';
import { recordPermissionActions } from '@test/support/permissionPanelEvents';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

interface PostedMessage {
  command: string;
  action?: string;
  threadId?: string;
  draft?: unknown;
}

let posted: PostedMessage[] = [];

// hostBridge resolves this global when the panel module is first imported.
(globalThis as Record<string, unknown>)[HOST_BRIDGE_API_KEY] = {
  postMessage: (message: unknown) => {
    posted.push(message as PostedMessage);
  },
  getState: () => undefined,
  setState: () => undefined,
};

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

function mountPanel(
  permission: ExternalInquiryPanel['permission'] = createPermission(),
): Promise<ExternalInquiryPanel> {
  return mountComponent<ExternalInquiryPanel>('external-inquiry-panel', {
    permission,
  });
}

function setTextareaValue(textarea: HTMLElement, value: string): void {
  (textarea as HTMLElement & { value: string }).value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function answerInputOf(element: ExternalInquiryPanel): HTMLElement {
  return element.shadowRoot!.querySelector(
    '.external-inquiry-request__answer-input',
  ) as HTMLElement;
}

function expectDraftPosted(threadId: string, draft: unknown): void {
  expect(posted).toEqual([
    {
      command: PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION,
      action: 'draft',
      threadId,
      draft,
    },
  ]);
}

describe('external-inquiry-panel answer/session-link inputs', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/ExternalInquiryPanel'),
  );

  beforeEach(() => {
    posted = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders wa-textarea for the answer and session-link inputs, never a native textarea', async () => {
    const element = await mountPanel();

    expect(element.shadowRoot!.querySelector('textarea')).toBeNull();
    expect(element.shadowRoot!.querySelectorAll('wa-textarea').length).toBe(2);
    expect(
      element
        .shadowRoot!.querySelector('.external-inquiry-request__answer-input')
        ?.tagName.toLowerCase(),
    ).toBe('wa-textarea');
    expect(
      element
        .shadowRoot!.querySelector(
          '.external-inquiry-request__session-links-input',
        )
        ?.tagName.toLowerCase(),
    ).toBe('wa-textarea');
  });

  it('reads the wa-textarea shadow-DOM value on input and submits it as the answer', async () => {
    const element = await mountPanel();
    const actions = recordPermissionActions(element);

    const answerInput = answerInputOf(element);
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
        action: 'submit',
        answer: 'the answer',
        sessionLinks: ['https://chatgpt.com/c/abc'],
      },
    ]);
  });

  it('debounces draft persistence from the latest input', async () => {
    const element = await mountPanel(
      createPermission({
        requestId: 'debounce-1',
        threadId: 'thread-debounce',
      }),
    );
    const answerInput = answerInputOf(element);
    vi.useFakeTimers();

    setTextareaValue(answerInput, 'first answer');
    vi.advanceTimersByTime(399);
    setTextareaValue(answerInput, 'latest answer');
    vi.advanceTimersByTime(399);

    expect(posted).toEqual([]);

    vi.advanceTimersByTime(1);

    expectDraftPosted('thread-debounce', {
      answer: 'latest answer',
      sessionLinks: '',
    });
  });

  it('flushes a pending draft once when disconnected', async () => {
    const element = await mountPanel(
      createPermission({
        requestId: 'disconnect-1',
        threadId: 'thread-disconnect',
      }),
    );
    const answerInput = answerInputOf(element);
    vi.useFakeTimers();

    setTextareaValue(answerInput, 'saved on disconnect');
    element.remove();

    expectDraftPosted('thread-disconnect', {
      answer: 'saved on disconnect',
      sessionLinks: '',
    });

    vi.advanceTimersByTime(400);
    expect(posted).toHaveLength(1);
  });

  it('cancels the timer and flushes the saved draft on permission replacement', async () => {
    const element = await mountPanel(
      createPermission({ requestId: 'replace-1', threadId: 'thread-old' }),
    );
    const answerInput = answerInputOf(element);
    vi.useFakeTimers();

    setTextareaValue(answerInput, 'answer for old permission');
    element.permission = createPermission({
      requestId: 'replace-2',
      threadId: 'thread-new',
    });
    await element.updateComplete;

    expectDraftPosted('thread-old', {
      answer: 'answer for old permission',
      sessionLinks: '',
    });

    vi.advanceTimersByTime(400);
    expect(posted).toHaveLength(1);
  });
});
