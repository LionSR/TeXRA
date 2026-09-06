// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';
import type { HostRequest } from '@shared/session/hostRequest';
import type { SessionView, StreamView } from '@shared/session/sessionView';
import {
  applySurfaceAction,
  emptySurface,
  type Surface,
  type SurfaceAction,
} from '@shared/session/surface';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import {
  CHILD,
  fanOutView,
  GRANDCHILD,
  ROOT,
} from '@test/shared/session/fanOutScenario';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/StreamTabs'),
);

/** Let the nested <stream-tab> rows finish their own first render. */
function settleChildRender(): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Mounted {
  readonly element: StreamTabs;
  readonly surfaceActions: SurfaceAction[];
  readonly requests: (RuntimeRequest | HostRequest)[];
}

async function mountTabs(
  view: SessionView,
  surface: Surface,
  props: Partial<StreamTabs> = {},
): Promise<Mounted> {
  const element = await mountComponent<StreamTabs>('stream-tabs', {
    view,
    surface,
    ...props,
  });
  const surfaceActions: SurfaceAction[] = [];
  const requests: (RuntimeRequest | HostRequest)[] = [];
  element.addEventListener('surface-action', (event) => {
    surfaceActions.push(event.detail);
  });
  element.addEventListener('runtime-request', (event) => {
    requests.push(event.detail);
  });
  await settleChildRender();
  return { element, surfaceActions, requests };
}

function rowOf(element: StreamTabs, streamId: string): HTMLElement {
  const rows = [...(element.shadowRoot?.querySelectorAll('stream-tab') ?? [])];
  const row = rows.find(
    (candidate) =>
      candidate.shadowRoot?.querySelector(
        `[data-stream="${streamId}"][data-action="select"]`,
      ) !== null,
  );
  if (!row) throw new Error(`no row for ${streamId}`);
  return row as HTMLElement;
}

function control(row: HTMLElement, action: string): HTMLElement {
  const control = row.shadowRoot?.querySelector<HTMLElement>(
    `[data-action="${action}"]`,
  );
  if (!control) throw new Error(`no ${action} control`);
  return control;
}

describe('stream-tabs over the fold', () => {
  it("renders every top-level stream with a workflow run's calls beneath it, and the rail without them", async () => {
    const view = fanOutView();
    const { element } = await mountTabs(view, emptySurface(view.key));

    for (const id of view.order) expect(rowOf(element, id)).toBeTruthy();
    // The root is a workflow run: its calls are reachable under it in the
    // tree (the issue's decision), so the child's own subagent is a row.
    expect(view.streams.get(ROOT)?.category).toBe('workflow');
    expect(rowOf(element, CHILD)).toBeTruthy();
    expect(rowOf(element, GRANDCHILD)).toBeTruthy();

    // The rail carries the rollup alone (W2): no tree at all.
    const { element: rail } = await mountTabs(view, emptySurface(view.key), {
      topLevelOnly: true,
    });
    expect(rail.shadowRoot?.querySelector('.child-streams')).toBeNull();
    expect(() => rowOf(rail, CHILD)).toThrow();
  });

  it('renders a subtree from its root with the children beneath the parent', async () => {
    const view = fanOutView();
    const child = view.streams.get(CHILD);
    expect(child?.childIds).toContain(GRANDCHILD);
    const { element } = await mountTabs(view, emptySurface(view.key), {
      root: CHILD,
    });

    expect(rowOf(element, CHILD)).toBeTruthy();
    expect(rowOf(element, GRANDCHILD)).toBeTruthy();
    const childList = element.shadowRoot?.querySelector('.child-streams');
    // Expanded exactly when the fold forces it or the surface asked.
    expect(childList?.hasAttribute('hidden')).toBe(
      child?.forceExpanded !== true,
    );
  });

  it('marks the resolved selection active and selects on click', async () => {
    const view = fanOutView();
    const surface = applySurfaceAction(emptySurface(view.key), {
      kind: 'select',
      streamId: GRANDCHILD,
    });
    const { element, surfaceActions } = await mountTabs(view, surface, {
      root: CHILD,
    });

    expect(rowOf(element, GRANDCHILD).hasAttribute('active')).toBe(true);
    expect(rowOf(element, CHILD).hasAttribute('active')).toBe(false);

    control(rowOf(element, CHILD), 'select').click();
    expect(surfaceActions).toEqual([{ kind: 'select', streamId: CHILD }]);
  });

  it('dispatches the delete arm and the expansion override from a row', async () => {
    const view = fanOutView();
    const child = view.streams.get(CHILD);
    const { element, surfaceActions, requests } = await mountTabs(
      view,
      emptySurface(view.key),
      { root: CHILD },
    );
    const row = rowOf(element, CHILD);

    control(row, 'delete').click();
    expect(requests).toEqual([{ kind: 'stream.delete', streamId: CHILD }]);

    control(row, 'toggle-children').click();
    expect(surfaceActions).toEqual([
      {
        kind: 'expand',
        streamId: CHILD,
        override: child?.forceExpanded ? 'collapsed' : 'expanded',
      },
    ]);
  });

  it('groups rows under section headings by their fold group', async () => {
    const view = fanOutView();
    const { element } = await mountTabs(view, emptySurface(view.key), {
      sections: true,
    });
    const headings = [
      ...(element.shadowRoot?.querySelectorAll('.group-heading') ?? []),
    ];
    const groups = new Set(view.order.map((id) => view.streams.get(id)?.group));
    expect(headings.length).toBe(groups.size);
    for (const heading of headings) {
      const group = [...heading.classList]
        .find((name) => name.startsWith('group-') && name !== 'group-heading')
        ?.slice('group-'.length);
      expect(groups.has(group as StreamView['group'])).toBe(true);
    }
  });

  it('filters rows by the surface search', async () => {
    const view = fanOutView();
    const label = view.streams.get(ROOT)?.label ?? '';
    const surface = applySurfaceAction(emptySurface(view.key), {
      kind: 'search',
      value: 'no such stream label',
    });
    const { element } = await mountTabs(view, surface);
    expect(element.shadowRoot?.querySelectorAll('stream-tab').length).toBe(0);

    element.surface = applySurfaceAction(surface, {
      kind: 'search',
      value: label.slice(0, 3),
    });
    await element.updateComplete;
    await settleChildRender();
    expect(rowOf(element, ROOT)).toBeTruthy();
  });
});
