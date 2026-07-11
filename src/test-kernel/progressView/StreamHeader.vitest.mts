// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - component type
import type { StreamHeader } from '@progressView/frontend/components/StreamHeader';
import type { StreamEventDetail } from '@progressView/frontend/events';

// Local imports - shared schemas
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

function baseStream(overrides: Partial<StreamTabInfo> = {}): StreamTabInfo {
  return {
    kind: 'agent',
    name: 'stream-a',
    label: 'Stream A',
    agentCategory: AgentCategory.Workflow,
    creationTimestamp: 1,
    ...overrides,
  };
}

async function mount(props: Partial<StreamHeader> = {}): Promise<StreamHeader> {
  const element = document.createElement('stream-header') as StreamHeader;
  element.stream = baseStream();
  Object.assign(element, props);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function dispatchKey(target: Element, key: string): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

// Single shared DOM/customElements registration for the whole file: each
// `useLitComponentTestDom` call tears down its jsdom window (and the
// customElements registry defined against it) in `afterAll`, and the
// `@progressView/frontend/components/StreamHeader` module — including its
// `customElements.define(...)` — only evaluates once thanks to ESM module
// caching. A second top-level call in this file would re-run against a
// fresh, unregistered window, silently leaving `stream-header` undefined for
// every test in that later block. Nest both suites under one registration
// instead of calling `useLitComponentTestDom` per describe.
describe('stream-header', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/StreamHeader'),
  );

  /**
   * Regression coverage for the a11y-clickables audit: the "go to parent
   * stream" label was a bare `<span @click>` with no role/tabindex/keydown, so
   * keyboard users could never reach or activate it even though `.parent-link`
   * already shipped a `:focus-visible` outline. Mirrors FileList.ts's
   * file-path keyboard-activation coverage for the same "clickable label"
   * job.
   */
  describe('parent-link keyboard activation', () => {
    it('exposes role=button and tabindex=0 on the parent-link span', async () => {
      const element = await mount({
        stream: baseStream({ parentStreamId: 'assistant@123' }),
      });

      const link = element.shadowRoot?.querySelector('.parent-link');
      expect(link).toBeInstanceOf(HTMLElement);
      expect(link?.getAttribute('role')).toBe('button');
      expect(link?.getAttribute('tabindex')).toBe('0');
    });

    it('switches to the parent stream on Enter and Space, not on other keys', async () => {
      const element = await mount({
        stream: baseStream({ parentStreamId: 'assistant@123' }),
      });
      const switches: StreamEventDetail[] = [];
      element.addEventListener('stream-switch', (event) => {
        switches.push((event as CustomEvent<StreamEventDetail>).detail);
      });

      const link = element.shadowRoot?.querySelector('.parent-link');
      expect(link).toBeInstanceOf(HTMLElement);

      dispatchKey(link!, 'a');
      expect(switches).toHaveLength(0);

      dispatchKey(link!, 'Enter');
      dispatchKey(link!, ' ');

      expect(switches).toEqual([
        { streamId: 'assistant@123' },
        { streamId: 'assistant@123' },
      ]);
    });

    it('renders nothing when there is no parent stream', async () => {
      const element = await mount({ stream: baseStream() });
      expect(element.shadowRoot?.querySelector('.parent-link')).toBeFalsy();
    });
  });

  /**
   * Regression coverage for #8158: the goal chip (`wa-badge`) and progress
   * badge (`wa-tag`) used native `title=` hover labels while the rest of the
   * header (e.g. the status indicator, id `statusIndicator`) already uses the
   * themed `wa-tooltip[for=]` mechanism. Both anchors must expose an id with a
   * sibling `<wa-tooltip for=id>` and no native `title` attribute, matching the
   * status-indicator pattern.
   */
  describe('tooltips', () => {
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
});
