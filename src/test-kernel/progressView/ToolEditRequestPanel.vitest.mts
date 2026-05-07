// Third-party imports
import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { PermissionState } from '@progressView/frontend/components/PermissionCard';
import type { ToolEditRequestPanel } from '@progressView/frontend/components/ToolEditRequestPanel';

// Local imports - shared schemas
import type { ToolEditPermission } from '@shared/schemas';

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  customElements: globalThis.customElements,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Document: globalThis.Document,
  ShadowRoot: globalThis.ShadowRoot,
  CSSStyleSheet: globalThis.CSSStyleSheet,
};

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
}

function createPermission(data: Partial<ToolEditPermission>): PermissionState {
  return {
    kind: 'toolEdit',
    data: {
      requestId: 'request-1',
      allowBypass: false,
      streamId: '',
      path: '/workspace/example.ts',
      relativePath: 'example.ts',
      sourceTool: 'edit',
      addedLines: 1,
      removedLines: 0,
      isLatex: false,
      ...data,
    },
  };
}

async function mountPanel(
  permission: PermissionState,
): Promise<ToolEditRequestPanel> {
  const element = document.createElement(
    'tool-edit-request-panel',
  ) as ToolEditRequestPanel;
  element.permission = permission;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

beforeAll(async () => {
  installDom();
  await import('@progressView/frontend/components/ToolEditRequestPanel');
});

afterEach(() => {
  document.body.replaceChildren();
});

afterAll(() => {
  restoreDom();
});

describe('tool-edit-request-panel', () => {
  it('renders inline diff when only proposed content is available', async () => {
    const element = await mountPanel(
      createPermission({
        proposedContent: 'new content\n',
      }),
    );

    element.handleKeyboardShortcut('d');
    await element.updateComplete;

    const diffView = element.shadowRoot?.querySelector('texra-diff-view') as
      | HTMLElement
      | undefined;
    expect(diffView).toBeTruthy();
    expect(
      (diffView as HTMLElement & { originalText?: string }).originalText,
    ).toBe('');
    expect(
      (diffView as HTMLElement & { proposedText?: string }).proposedText,
    ).toBe('new content\n');
  });

  it('renders inline diff when only original content is available', async () => {
    const element = await mountPanel(
      createPermission({
        originalContent: 'deleted content\n',
      }),
    );

    element.handleKeyboardShortcut('d');
    await element.updateComplete;

    const diffView = element.shadowRoot?.querySelector('texra-diff-view') as
      | HTMLElement
      | undefined;
    expect(diffView).toBeTruthy();
    expect(
      (diffView as HTMLElement & { originalText?: string }).originalText,
    ).toBe('deleted content\n');
    expect(
      (diffView as HTMLElement & { proposedText?: string }).proposedText,
    ).toBe('');
  });
});
