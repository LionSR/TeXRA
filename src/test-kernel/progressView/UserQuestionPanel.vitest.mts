// Third-party imports
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Local imports - progress view component types

// Local imports - shared constants
import type { UserQuestionPanel } from '@progressView/frontend/components/UserQuestionPanel';
import type { UserQuestionPrompt } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

// Local imports - test utilities
import { installAttachInternalsFallback } from '../settings/litComponentTestUtils';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  customElements: globalThis.customElements,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Document: globalThis.Document,
  ShadowRoot: globalThis.ShadowRoot,
  CSSStyleSheet: globalThis.CSSStyleSheet,
  Event: globalThis.Event,
  CustomEvent: globalThis.CustomEvent,
  ResizeObserver: globalThis.ResizeObserver,
  Node: (globalThis as { Node?: unknown }).Node,
};

class NoopResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'http://localhost',
  });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.customElements = dom.window.customElements;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Element = dom.window.Element;
  globalThis.Document = dom.window.Document;
  globalThis.ShadowRoot = dom.window.ShadowRoot;
  globalThis.CSSStyleSheet = dom.window.CSSStyleSheet;
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.ResizeObserver = NoopResizeObserver;
  (globalThis as { Node: unknown }).Node = dom.window.Node;
  installAttachInternalsFallback(
    dom.window as unknown as Parameters<
      typeof installAttachInternalsFallback
    >[0],
  );
  return dom;
}

function restoreDom(): void {
  globalThis.document = originalGlobals.document;
  globalThis.window = originalGlobals.window;
  globalThis.customElements = originalGlobals.customElements;
  globalThis.HTMLElement = originalGlobals.HTMLElement;
  globalThis.Element = originalGlobals.Element;
  globalThis.Document = originalGlobals.Document;
  globalThis.ShadowRoot = originalGlobals.ShadowRoot;
  globalThis.CSSStyleSheet = originalGlobals.CSSStyleSheet;
  globalThis.Event = originalGlobals.Event;
  globalThis.CustomEvent = originalGlobals.CustomEvent;
  globalThis.ResizeObserver = originalGlobals.ResizeObserver;
  if (originalGlobals.Node === undefined) {
    delete (globalThis as { Node?: unknown }).Node;
  } else {
    (globalThis as { Node: unknown }).Node = originalGlobals.Node;
  }
}

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

async function mountPanel(
  permission: UserQuestionPanel['permission'] = createPermission(),
): Promise<UserQuestionPanel> {
  const element = document.createElement(
    'user-question-panel',
  ) as UserQuestionPanel;
  element.permission = permission;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function collectActions(
  element: UserQuestionPanel,
): Array<{ action: string; answers?: Record<string, string | string[]> }> {
  const actions: Array<{
    action: string;
    answers?: Record<string, string | string[]>;
  }> = [];
  element.addEventListener('permission-action', (event) => {
    actions.push(
      (
        event as CustomEvent<{
          decision: {
            action: string;
            answers?: Record<string, string | string[]>;
          };
        }>
      ).detail.decision,
    );
  });
  return actions;
}

beforeAll(async () => {
  installDom();
  await import('@progressView/frontend/components/UserQuestionPanel');
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(() => {
  restoreDom();
});

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

    const button = element.shadowRoot?.querySelector(
      'wa-button[data-action="submit"]',
    ) as HTMLElement & { disabled?: boolean };
    expect(button?.disabled).toBe(true);
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
    red.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    blue.checked = true;
    blue.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await element.updateComplete;

    const button = element.shadowRoot?.querySelector(
      'wa-button[data-action="submit"]',
    ) as HTMLElement & { disabled?: boolean };
    expect(button?.disabled).toBe(false);

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
    radioGroup.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );
    await element.updateComplete;

    const actions = collectActions(element);
    element.handleKeyboardShortcut('y');
    expect(actions).toEqual([
      { action: 'submit', answers: { 'Pick one': 'No' } },
    ]);
  });
});
