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

/**
 * Regression coverage for the a11y-clickables audit: the "go to parent
 * stream" label was a bare `<span @click>` with no role/tabindex/keydown, so
 * keyboard users could never reach or activate it even though `.parent-link`
 * already shipped a `:focus-visible` outline. Mirrors FileList.ts's
 * file-path keyboard-activation coverage for the same "clickable label"
 * job.
 */
describe('stream-header parent-link keyboard activation', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/StreamHeader'),
  );

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
