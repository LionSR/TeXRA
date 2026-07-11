// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component type
import type { StreamHeader } from '@progressView/frontend/components/StreamHeader';

// Local imports - shared schemas
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';

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

async function mount(
  props: Partial<StreamHeader> = {},
): Promise<StreamHeader> {
  const element = document.createElement('stream-header') as StreamHeader;
  element.stream = baseStream();
  Object.assign(element, props);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

/**
 * Regression coverage for #8158: the goal chip (`wa-badge`) and progress
 * badge (`wa-tag`) used native `title=` hover labels while the rest of the
 * header (e.g. the status indicator, id `statusIndicator`) already uses the
 * themed `wa-tooltip[for=]` mechanism. Both anchors must expose an id with a
 * sibling `<wa-tooltip for=id>` and no native `title` attribute, matching the
 * status-indicator pattern.
 */
describe('stream-header tooltips', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/StreamHeader'),
  );

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
