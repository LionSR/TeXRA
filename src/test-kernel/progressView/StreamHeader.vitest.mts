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

// Shared DOM setup for every describe block below — `useLitComponentTestDom`
// creates one jsdom + registers `stream-header` once; calling it again per
// describe would rebind `customElements` to a second jsdom instance without
// the class registered on it, silently leaving `element.shadowRoot`
// undefined for the second block's tests.
useLitComponentTestDom(
  () => import('@progressView/frontend/components/StreamHeader'),
);

/**
 * Regression coverage for #8158: the goal chip (`wa-badge`) and progress
 * badge (`wa-tag`) used native `title=` hover labels while the rest of the
 * header (e.g. the status indicator, id `statusIndicator`) already uses the
 * themed `wa-tooltip[for=]` mechanism. Both anchors must expose an id with a
 * sibling `<wa-tooltip for=id>` and no native `title` attribute, matching the
 * status-indicator pattern.
 */
describe('stream-header tooltips', () => {
  it('anchors the goal chip tooltip via wa-tooltip[for], not a native title', async () => {
    const element = await mount({
      goalActive: true,
      goalStatus: 'active',
      goalObjective: 'ship the fix',
    });

    const chip = element.shadowRoot?.querySelector('#goalChip');
    expect(chip).toBeTruthy();
    expect(chip?.hasAttribute('title')).toBe(false);

    const tooltip = element.shadowRoot?.querySelector(
      'wa-tooltip[for="goalChip"]',
    );
    expect(tooltip).toBeTruthy();
    expect(tooltip?.textContent?.trim()).toBe('Goal: ship the fix');
  });

  it('anchors the progress badge tooltip via wa-tooltip[for], not a native title', async () => {
    const element = await mount({
      roundStage: { index: 0, total: 2 },
    });

    const badge = element.shadowRoot?.querySelector('#progressBadge');
    expect(badge).toBeTruthy();
    expect(badge?.hasAttribute('title')).toBe(false);

    const tooltip = element.shadowRoot?.querySelector(
      'wa-tooltip[for="progressBadge"]',
    );
    expect(tooltip).toBeTruthy();
    expect(tooltip?.textContent?.trim()).toBe('Round 1 of 2');
  });

  it('omits the progress badge tooltip entirely when there is no title text', async () => {
    const element = await mount({});

    expect(element.shadowRoot?.querySelector('#progressBadge')).toBeFalsy();
    expect(
      element.shadowRoot?.querySelector('wa-tooltip[for="progressBadge"]'),
    ).toBeFalsy();
  });
});

/**
 * Regression coverage for consolidating the toolbar's wa-button-group +
 * external-tooltip workaround onto `renderIconActionButtonParts` (src/
 * shared/wa/actionButtons.ts): each toolbar button must anchor its own
 * `<wa-tooltip>` by id (not via a slotted child, which would break
 * wa-button-group's corner-fusion), and clicking a button must dispatch
 * `toolbar-command` directly — no more delegated `[data-command]` lookup.
 */
describe('stream-header toolbar', () => {
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
