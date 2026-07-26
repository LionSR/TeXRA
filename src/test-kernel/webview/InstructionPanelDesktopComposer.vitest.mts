import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import type { SessionContextValue } from '@shared/schemas';

// Local imports - component type and context
import type { InstructionPanel } from '@webview/frontend/components/InstructionPanel';
import type { sessionContext } from '@webview/frontend/contexts/mainViewContexts';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';
import type { ContextProvider } from '@lit/context';

// @lit/context captures the global Event constructor at module-evaluation time,
// so runtime imports must happen after the jsdom globals are installed.
let ContextProviderCtor: typeof ContextProvider;
let mainViewSessionContext: typeof sessionContext;

const SESSION: SessionContextValue = {
  sessionType: 'toolUse',
  launchTarget: 'agent',
  selectedTeamId: '',
  instruction: 'Polish the abstract.',
  placeholder: 'Describe the edit…',
  workflowAgent: 'copy-editor',
  toolUseAgent: 'assistant',
  model: 'model-a',
  workflowAgentOptions: [],
  toolUseAgentOptions: [],
  modelOptions: [],
  teamOptions: [],
  workspaceRootOptions: [],
  workingDirectory: '',
  isRecording: false,
  isPolishing: false,
  debugMode: false,
  isOrchestratorSelected: false,
  statusAnnouncement: '',
};

async function mountPanel(
  desktopHost: boolean,
  session: SessionContextValue = SESSION,
): Promise<InstructionPanel> {
  const wrapper = document.createElement('div');
  const provider = new ContextProviderCtor(wrapper, {
    context: mainViewSessionContext,
    initialValue: session,
  });
  provider.hostConnected();

  const element = document.createElement(
    'instruction-panel',
  ) as InstructionPanel;
  element.desktopHost = desktopHost;
  wrapper.append(element);
  document.body.append(wrapper);
  await element.updateComplete;
  return element;
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

describe('instruction-panel desktop composer', () => {
  useLitComponentTestDom(async () => {
    ({ ContextProvider: ContextProviderCtor } = await import('@lit/context'));
    ({ sessionContext: mainViewSessionContext } =
      await import('@webview/frontend/contexts/mainViewContexts'));
    await import('@webview/frontend/components/InstructionPanel');
  });

  it('opts into the desktop treatment without changing the extension default', async () => {
    const desktop = await mountPanel(true);
    const extension = await mountPanel(false);

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
    expect(query(desktop, '#instruction').getAttribute('rows')).toBe('4');
    expect(query(desktop, '#instruction').getAttribute('enterkeyhint')).toBe(
      'send',
    );
    expect(query(desktop, '#executeButton').getAttribute('aria-label')).toBe(
      'Send request',
    );
    expect(query(desktop, '.execute-button__label').textContent?.trim()).toBe(
      'Send',
    );
    expect(query(desktop, '#executeButton wa-icon').getAttribute('slot')).toBe(
      'start',
    );
    expect(desktop.shadowRoot?.querySelector('#sessionTypeToggle')).toBeNull();
    expect(desktop.shadowRoot?.querySelector('#launchTargetToggle')).toBeNull();
    expect(query(desktop, '#desktopLaunchMode').getAttribute('size')).toBe(
      'xs',
    );
    for (const id of ['#desktopLaunchMode', '#toolUseAgent', '#model']) {
      expect(query(desktop, id).getAttribute('size')).toBe('xs');
    }
    expect(
      query(desktop, '.desktop-drop-affordance .icon-surface.is-size-m'),
    ).toBeTruthy();

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
    expect(
      query(extension, '#executeButton wa-icon').getAttribute('slot'),
    ).toBe('start');
    expect(
      query(extension, '#sessionTypeToolUse').getAttribute('appearance'),
    ).toBe('default');
    expect(query(extension, '.execute-button__label').textContent?.trim()).toBe(
      'Run',
    );
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
    const changes: Array<{ event: string; value: string }> = [];
    element.addEventListener('session-type-change', (event) => {
      changes.push({
        event: 'session-type-change',
        value: (event as CustomEvent<{ value: string }>).detail.value,
      });
    });
    element.addEventListener('launch-target-change', (event) => {
      changes.push({
        event: 'launch-target-change',
        value: (event as CustomEvent<{ value: string }>).detail.value,
      });
    });

    mode.value = 'team';
    mode.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    expect(changes).toEqual([
      { event: 'session-type-change', value: 'toolUse' },
      { event: 'launch-target-change', value: 'team' },
    ]);

    changes.length = 0;
    mode.value = 'workflow';
    mode.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    expect(changes).toEqual([
      { event: 'session-type-change', value: 'workflow' },
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
    let selected = '';
    multiRoot.addEventListener('working-directory-change', (event) => {
      selected = (event as CustomEvent<{ value: string }>).detail.value;
    });

    expect(picker.getAttribute('aria-label')).toBe('Working directory');
    expect(
      multiRoot.shadowRoot?.querySelectorAll('#workingDirectory wa-option'),
    ).toHaveLength(2);

    picker.value = '/workspace/figures';
    picker.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    expect(selected).toBe('/workspace/figures');
  });

  it('sends on Enter in desktop mode and preserves Shift+Enter for a newline', async () => {
    const element = await mountPanel(true);
    const textarea = query(element, '#instruction');
    let executeCount = 0;
    element.addEventListener('execute', () => {
      executeCount += 1;
    });

    const newlineEvent = dispatchEnter(textarea, { shiftKey: true });
    expect(newlineEvent.defaultPrevented).toBe(false);
    expect(executeCount).toBe(0);

    const sendEvent = dispatchEnter(textarea);
    expect(sendEvent.defaultPrevented).toBe(true);
    expect(executeCount).toBe(1);
  });

  it('leaves plain Enter untouched in the extension panel', async () => {
    const element = await mountPanel(false);
    let executeCount = 0;
    element.addEventListener('execute', () => {
      executeCount += 1;
    });

    const event = dispatchEnter(query(element, '#instruction'));
    expect(event.defaultPrevented).toBe(false);
    expect(executeCount).toBe(0);
  });

  it('keeps send disabled until the request and required selections exist', async () => {
    const element = await mountPanel(true, {
      ...SESSION,
      instruction: '',
    });
    const executeButton = query(element, '#executeButton');
    let executeCount = 0;
    element.addEventListener('execute', () => {
      executeCount += 1;
    });

    expect(executeButton.hasAttribute('disabled')).toBe(true);
    dispatchEnter(query(element, '#instruction'));
    expect(executeCount).toBe(0);
  });
});
