// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { StreamHeader } from '@progressView/frontend/components/StreamHeader';
import { ELEMENT_IDS } from '@progressView/frontend/constants';
import type { HostRequest } from '@shared/session/hostRequest';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import type { SurfaceAction } from '@shared/session/surface';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { CHILD, fanOutView, ROOT } from '@test/shared/session/fanOutScenario';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/StreamHeader'),
);

interface Mounted {
  readonly element: StreamHeader;
  readonly surfaceActions: SurfaceAction[];
  readonly requests: (RuntimeRequest | HostRequest)[];
}

function streamOf(view: SessionView, id: string): StreamView {
  const stream = view.streams.get(id);
  if (!stream) throw new Error(`fixture has no stream ${id}`);
  return stream;
}

async function mountHeader(
  view: SessionView,
  stream: StreamView,
): Promise<Mounted> {
  const element = await mountComponent<StreamHeader>('stream-header', {
    view,
    stream,
  });
  const surfaceActions: SurfaceAction[] = [];
  const requests: (RuntimeRequest | HostRequest)[] = [];
  element.addEventListener('surface-action', (event) => {
    surfaceActions.push(event.detail);
  });
  element.addEventListener('runtime-request', (event) => {
    requests.push(event.detail);
  });
  element.addEventListener('host-request', (event) => {
    requests.push(event.detail);
  });
  return { element, surfaceActions, requests };
}

/** Themed-tooltip contract: anchor carries an id, no native title, sibling wa-tooltip[for=id]. */
function expectAnchoredTooltip(element: StreamHeader, anchorId: string): void {
  const anchor = element.shadowRoot?.querySelector(`#${anchorId}`);
  expect(anchor).toBeTruthy();
  expect(anchor?.hasAttribute('title')).toBe(false);
  expect(
    element.shadowRoot?.querySelector(`wa-tooltip[for="${anchorId}"]`),
  ).toBeTruthy();
}

describe('stream-header over the fold', () => {
  it('names the stream and its status from the view, with anchored tooltips', async () => {
    const view = fanOutView();
    const stream = streamOf(view, ROOT);
    const { element } = await mountHeader(view, stream);

    const name = element.shadowRoot?.querySelector<HTMLElement>(
      `#${ELEMENT_IDS.ACTIVE_STREAM_NAME}`,
    );
    expect(name?.textContent?.trim()).toBe(stream.label);
    expect(name?.dataset.stream).toBe(ROOT);
    expectAnchoredTooltip(element, ELEMENT_IDS.ACTIVE_STREAM_NAME);

    const status = element.shadowRoot?.querySelector(
      `#${ELEMENT_IDS.STATUS_INDICATOR}`,
    );
    expect(status?.getAttribute('role')).toBe('img');
    expect(status?.getAttribute('aria-label')).toBe(stream.statusLabel);
    expectAnchoredTooltip(element, ELEMENT_IDS.STATUS_INDICATOR);
  });

  it('renders the ancestors path for a child and selects the ancestor on activation', async () => {
    const view = fanOutView();
    const child = streamOf(view, CHILD);
    expect(child.ancestors.map((ancestor) => ancestor.id)).toEqual([ROOT]);
    const { element, surfaceActions } = await mountHeader(view, child);

    const link = element.shadowRoot?.querySelector<HTMLElement>(
      'nav.ancestors button.ancestor',
    );
    expect(link?.getAttribute('aria-label')).toBe(
      `Go to ${child.ancestors[0]?.label}`,
    );
    link?.click();
    expect(surfaceActions).toEqual([{ kind: 'select', streamId: ROOT }]);
  });

  it('renders no ancestors path for a top-level stream', async () => {
    const view = fanOutView();
    const { element } = await mountHeader(view, streamOf(view, ROOT));
    expect(element.shadowRoot?.querySelector('nav.ancestors')).toBeNull();
  });

  it('dispatches the stop arm from the toolbar of a running stream', async () => {
    const view = fanOutView();
    const stream = streamOf(view, ROOT);
    expect(stream.group).toBe('running');
    const { element, requests } = await mountHeader(view, stream);

    const stop = element.shadowRoot?.querySelector<HTMLElement>(
      `#${ELEMENT_IDS.STOP_STREAM_BTN}`,
    );
    expect(stop?.tagName.toLowerCase()).toBe('wa-button');
    expectAnchoredTooltip(element, ELEMENT_IDS.STOP_STREAM_BTN);
    stop?.click();
    expect(requests).toEqual([{ kind: 'stream.stop', streamId: ROOT }]);
  });

  it('offers no copy-run-context action on a workflow-script run or a tool-use stream', async () => {
    const view = fanOutView();
    const root = streamOf(view, ROOT);
    expect(root.identity?.kind).toBe('multiAgentWorkflow');
    const { element: script } = await mountHeader(view, root);
    expect(
      script.shadowRoot?.querySelector(`#${ELEMENT_IDS.COPY_RUN_CONTEXT_BTN}`),
    ).toBeNull();

    const child = streamOf(view, CHILD);
    expect(child.category).toBe('toolUse');
    const { element: toolUse } = await mountHeader(view, child);
    expect(
      toolUse.shadowRoot?.querySelector(`#${ELEMENT_IDS.COPY_RUN_CONTEXT_BTN}`),
    ).toBeNull();
  });
});
