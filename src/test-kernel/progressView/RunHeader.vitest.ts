// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { RunHeader } from '@progressView/frontend/components/RunHeader';
import { ELEMENT_IDS } from '@progressView/frontend/constants';
import type { RunId } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import type { SessionView, RunView } from '@shared/session/sessionView';
import type { SurfaceAction } from '@shared/session/surface';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { CHILD, fanOutView, ROOT } from '@test/shared/session/fanOutScenario';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/RunHeader'),
);

interface Mounted {
  readonly element: RunHeader;
  readonly surfaceActions: SurfaceAction[];
  readonly requests: (RuntimeRequest | HostRequest)[];
}

function runOfEvent(view: SessionView, id: RunId): RunView {
  const run = view.runs.get(id);
  if (!run) throw new Error(`fixture has no run ${id}`);
  return run;
}

async function mountHeader(
  view: SessionView,
  stream: RunView,
): Promise<Mounted> {
  const element = await mountComponent<RunHeader>('stream-header', {
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
function expectAnchoredTooltip(element: RunHeader, anchorId: string): void {
  const anchor = element.shadowRoot?.querySelector(`#${anchorId}`);
  expect(anchor).toBeTruthy();
  expect(anchor?.hasAttribute('title')).toBe(false);
  expect(
    element.shadowRoot?.querySelector(`wa-tooltip[for="${anchorId}"]`),
  ).toBeTruthy();
}

describe('stream-header over the fold', () => {
  it('renders the ancestors path for a child and selects the ancestor on activation', async () => {
    const view = fanOutView();
    const child = runOfEvent(view, CHILD);
    expect(child.ancestors.map((ancestor) => ancestor.id)).toEqual([ROOT]);
    const { element, surfaceActions } = await mountHeader(view, child);

    const link = element.shadowRoot?.querySelector<HTMLElement>(
      'nav.ancestors button.ancestor',
    );
    expect(link?.getAttribute('aria-label')).toBe(
      `Go to ${child.ancestors[0]?.label}`,
    );
    link?.click();
    expect(surfaceActions).toEqual([{ kind: 'select', runId: ROOT }]);
  });

  it('dispatches the stop arm from the toolbar of a running stream', async () => {
    const view = fanOutView();
    const stream = runOfEvent(view, ROOT);
    expect(stream.group).toBe('running');
    const { element, requests } = await mountHeader(view, stream);

    const stop = element.shadowRoot?.querySelector<HTMLElement>(
      `#${ELEMENT_IDS.STOP_STREAM_BTN}`,
    );
    expect(stop?.tagName.toLowerCase()).toBe('wa-button');
    expectAnchoredTooltip(element, ELEMENT_IDS.STOP_STREAM_BTN);
    stop?.click();
    expect(requests).toEqual([{ kind: 'run.stop', runId: ROOT }]);
  });
});
