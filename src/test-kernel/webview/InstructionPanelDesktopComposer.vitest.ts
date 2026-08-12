import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import type { SessionContextValue } from '@shared/schemas';

// Local imports - component type
import type { InstructionPanel } from '@webview/frontend/components/InstructionPanel';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';
import {
  loadInstructionPanelModules,
  makeSession,
  mountInstructionPanel,
} from './mainViewTestUtils';

const SESSION = makeSession({ instruction: 'Polish the abstract.' });

function mountPanel(
  desktopHost: boolean,
  session: SessionContextValue = SESSION,
): Promise<InstructionPanel> {
  return mountInstructionPanel(session, { desktopHost });
}

function query<T extends HTMLElement>(
  element: InstructionPanel,
  selector: string,
): T {
  const match = element.shadowRoot?.querySelector<T>(selector);
  if (!match) throw new Error(`Missing ${selector}`);
  return match;
}

function dispatchEnter(
  textarea: HTMLElement,
  overrides: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    composed: true,
    cancelable: true,
    ...overrides,
  });
  textarea.dispatchEvent(event);
  return event;
}

function dispatchChange(element: HTMLElement): void {
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function recordEvents(
  element: HTMLElement,
  types: readonly string[],
): Array<{ type: string; value: string }> {
  const events: Array<{ type: string; value: string }> = [];
  for (const type of types) {
    element.addEventListener(type, (event) => {
      events.push({
        type,
        value: (event as CustomEvent<{ value: string }>).detail.value,
      });
    });
  }
  return events;
}

function countExecutes(element: InstructionPanel): () => number {
  let count = 0;
  element.addEventListener('execute', () => {
    count += 1;
  });
  return () => count;
}

describe('instruction-panel desktop composer', () => {
  useLitComponentTestDom(loadInstructionPanelModules);

  it('opts into the desktop layout and controls when desktopHost is set', async () => {
    const desktop = await mountPanel(true);

    expect(desktop.hasAttribute('desktop-host')).toBe(true);
    expect(query(desktop, '.desktop-drop-affordance')).toBeTruthy();
    expect(query(desktop, '.desktop-mode-controls')).toBeTruthy();
    expect(
      query(desktop, '.desktop-mode-controls #desktopLaunchMode'),
    ).toBeTruthy();
    expect(
      desktop.shadowRoot?.querySelector(
        '.instruction-header #sessionTypeToggle',
      ),
    ).toBeNull();
    expect(desktop.shadowRoot?.querySelector('#sessionTypeToggle')).toBeNull();
    expect(desktop.shadowRoot?.querySelector('#launchTargetToggle')).toBeNull();
    expect(
      query(desktop, '.desktop-drop-affordance .icon-surface.is-size-m'),
    ).toBeTruthy();
  });

  it('uses the compact composer affordances on desktop', async () => {
    const desktop = await mountPanel(true);

    expect(query(desktop, '#instruction').getAttribute('rows')).toBe('4');
    expect(query(desktop, '#instruction').getAttribute('enterkeyhint')).toBe(
      'send',
    );
    expect(query(desktop, '#executeButton').getAttribute('aria-label')).toBe(
      'Send request',
    );
    expect(query(desktop, '#executeButton wa-icon').getAttribute('name')).toBe(
      'arrow-up',
    );
    for (const id of ['#desktopLaunchMode', '#toolUseAgent', '#model']) {
      expect(query(desktop, id).getAttribute('size')).toBe('xs');
    }
  });

  it('keeps the extension panel on the default treatment when desktopHost is unset', async () => {
    const extension = await mountPanel(false);

    expect(extension.hasAttribute('desktop-host')).toBe(false);
    expect(
      extension.shadowRoot?.querySelector('.desktop-drop-affordance'),
    ).toBe(null);
    expect(query(extension, '#instruction').getAttribute('rows')).toBe('10');
    expect(query(extension, '#instruction').hasAttribute('enterkeyhint')).toBe(
      false,
    );
    expect(
      query(extension, '.instruction-header #sessionTypeToggle'),
    ).toBeTruthy();
    expect(query(extension, '#executeButton').getAttribute('aria-label')).toBe(
      'Run agent',
    );
    expect(
      query(extension, '#executeButton wa-icon').getAttribute('name'),
    ).toBe('arrow-up');
    expect(
      query(extension, '#sessionTypeToolUse').getAttribute('appearance'),
    ).toBe('default');
  });

  it('maps the unified desktop mode picker to the existing session state', async () => {
    const element = await mountPanel(true, {
      ...SESSION,
      sessionType: 'workflow',
      launchTarget: 'agent',
    });
    const mode = query<HTMLElement & { value: string }>(
      element,
      '#desktopLaunchMode',
    );
    const changes = recordEvents(element, [
      'session-type-change',
      'launch-target-change',
    ]);

    mode.value = 'team';
    dispatchChange(mode);

    expect(changes).toEqual([
      { type: 'session-type-change', value: 'toolUse' },
      { type: 'launch-target-change', value: 'team' },
    ]);

    changes.length = 0;
    mode.value = 'workflow';
    dispatchChange(mode);

    expect(changes).toEqual([
      { type: 'session-type-change', value: 'workflow' },
    ]);
  });

  it('shows and updates the working directory only for multi-root workspaces', async () => {
    const singleRoot = await mountPanel(true, {
      ...SESSION,
      workspaceRootOptions: [{ label: 'paper', value: '/workspace/paper' }],
      workingDirectory: '/workspace/paper',
    });
    expect(
      singleRoot.shadowRoot?.querySelector('#workingDirectory'),
    ).toBeNull();

    const multiRoot = await mountPanel(true, {
      ...SESSION,
      workspaceRootOptions: [
        { label: 'paper', value: '/workspace/paper' },
        { label: 'figures', value: '/workspace/figures' },
      ],
      workingDirectory: '/workspace/paper',
    });
    const picker = query<HTMLElement & { value: string }>(
      multiRoot,
      '#workingDirectory',
    );
    const changes = recordEvents(multiRoot, ['working-directory-change']);

    expect(picker.getAttribute('aria-label')).toBe('Working directory');
    expect(
      multiRoot.shadowRoot?.querySelectorAll('#workingDirectory wa-option'),
    ).toHaveLength(2);

    picker.value = '/workspace/figures';
    dispatchChange(picker);

    expect(changes).toEqual([
      { type: 'working-directory-change', value: '/workspace/figures' },
    ]);
  });

  it('sends on Enter in desktop mode and preserves Shift+Enter for a newline', async () => {
    const element = await mountPanel(true);
    const textarea = query(element, '#instruction');
    const executeCount = countExecutes(element);

    const newlineEvent = dispatchEnter(textarea, { shiftKey: true });
    expect(newlineEvent.defaultPrevented).toBe(false);
    expect(executeCount()).toBe(0);

    const sendEvent = dispatchEnter(textarea);
    expect(sendEvent.defaultPrevented).toBe(true);
    expect(executeCount()).toBe(1);
  });

  it('leaves plain Enter untouched in the extension panel', async () => {
    const element = await mountPanel(false);
    const executeCount = countExecutes(element);

    const event = dispatchEnter(query(element, '#instruction'));
    expect(event.defaultPrevented).toBe(false);
    expect(executeCount()).toBe(0);
  });

  it('keeps send disabled until the request and required selections exist', async () => {
    const element = await mountPanel(true, {
      ...SESSION,
      instruction: '',
    });
    const executeButton = query(element, '#executeButton');
    const executeCount = countExecutes(element);

    expect(executeButton.hasAttribute('disabled')).toBe(true);
    dispatchEnter(query(element, '#instruction'));
    expect(executeCount()).toBe(0);
  });
});
