// Third-party imports
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { PermissionState } from '@progressView/frontend/components/PermissionCard';
import type { UserQuestionPanel } from '@progressView/frontend/components/UserQuestionPanel';

// Local imports - shared constants
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

function createPermission(): PermissionState {
  return {
    kind: PERMISSION_KIND.USER_QUESTION,
    data: {
      requestId: 'question-1',
      allowBypass: false,
      streamId: 'stream-1',
      questions: [
        {
          question: 'Choose an answer',
          options: [{ label: 'A' }, { label: 'B' }],
          allowFreeText: true,
        },
      ],
    },
  };
}

async function mountPanel(): Promise<UserQuestionPanel> {
  const element = document.createElement(
    'user-question-panel',
  ) as UserQuestionPanel;
  element.permission = createPermission();
  document.body.append(element);
  await element.updateComplete;
  return element;
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
    const actions: string[] = [];
    element.addEventListener('permission-action', (event) => {
      actions.push((event as CustomEvent<{ action: string }>).detail.action);
    });

    expect(element.handleKeyboardShortcut('n')).toBe(true);
    await element.updateComplete;

    expect(element.handleKeyboardShortcut('y')).toBe(false);
    expect(actions).toEqual([]);
  });
});
