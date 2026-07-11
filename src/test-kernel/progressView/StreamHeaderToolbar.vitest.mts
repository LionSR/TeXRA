// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component type
import type { StreamHeader } from '@progressView/frontend/components/StreamHeader';
import { ELEMENT_IDS } from '@progressView/frontend/constants';

// Local imports - shared schemas
import {
  AgentCategory,
  STREAM_PHASE,
  type StreamTabInfo,
} from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

function baseStream(): StreamTabInfo {
  return {
    kind: 'agent',
    name: 'stream-a',
    label: 'Stream A',
    agentCategory: AgentCategory.Workflow,
    creationTimestamp: 1,
  };
}

async function mount(props: Partial<StreamHeader> = {}): Promise<StreamHeader> {
  const element = document.createElement('stream-header') as StreamHeader;
  element.stream = baseStream();
  element.status = STREAM_PHASE.RUNNING;
  // Buttons default to hidden until the host confirms which commands it
  // supports (`isKnownUnsupported` treats `null` as "unknown, so hide").
  element.unsupportedCommands = new Set();
  Object.assign(element, props);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

/**
 * Regression coverage for consolidating the toolbar's wa-button-group +
 * external-tooltip workaround onto `renderIconActionButtonParts` (src/
 * shared/wa/actionButtons.ts): each toolbar button must anchor its own
 * `<wa-tooltip>` by id (not via a slotted child, which would break
 * wa-button-group's corner-fusion), and clicking a button must dispatch
 * `toolbar-command` directly — no more delegated `[data-command]` lookup.
 */
describe('stream-header toolbar', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/StreamHeader'),
  );

  it('renders the stop button as a wa-button with a matching sibling tooltip', async () => {
    const element = await mount();

    const stopButton = element.shadowRoot?.querySelector<HTMLElement>(
      `#${ELEMENT_IDS.STOP_STREAM_BTN}`,
    );
    expect(stopButton).toBeTruthy();
    expect(stopButton?.tagName).toBe('WA-BUTTON');
    expect(stopButton?.hasAttribute('data-command')).toBe(false);

    const stopTooltip = element.shadowRoot?.querySelector(
      `wa-tooltip[for="${ELEMENT_IDS.STOP_STREAM_BTN}"]`,
    );
    expect(stopTooltip).toBeTruthy();
  });

  it('dispatches toolbar-command with the button-specific command on click', async () => {
    const element = await mount();
    const events: unknown[] = [];
    element.addEventListener('toolbar-command', (event) => {
      events.push((event as CustomEvent).detail);
    });

    const stopButton = element.shadowRoot?.querySelector<HTMLElement>(
      `#${ELEMENT_IDS.STOP_STREAM_BTN}`,
    );
    stopButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ command: expect.any(String) });
  });
});
