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

    expect(extension.hasAttribute('desktop-host')).toBe(false);
    expect(
      extension.shadowRoot?.querySelector('.desktop-drop-affordance'),
    ).toBe(null);
    expect(query(extension, '#instruction').getAttribute('rows')).toBe('10');
    expect(query(extension, '#instruction').hasAttribute('enterkeyhint')).toBe(
      false,
    );
    expect(query(extension, '.execute-button__label').textContent?.trim()).toBe(
      'Run',
    );
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
