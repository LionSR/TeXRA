// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { RunTabs } from '@progressView/frontend/components/RunTabs';
import type { SessionView } from '@shared/session/sessionView';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { fanOutView, ROOT } from '@test/shared/session/fanOutScenario';
import {
  emptySurface,
  type Surface,
  type SurfaceAction,
} from '@texra/shared/session/surface';
import type { HostRequest } from '@texra/shared/session/hostRequest';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/RunTabs'),
);

/** Let the nested <run-tab> rows finish their own first render. */
function settleChildRender(): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Mounted {
  readonly element: RunTabs;
  readonly surfaceActions: SurfaceAction[];
  readonly requests: (RuntimeRequest | HostRequest)[];
}

async function mountTabs(
  view: SessionView,
  surface: Surface,
  props: Partial<RunTabs> = {},
): Promise<Mounted> {
  const element = await mountComponent<RunTabs>('run-tabs', {
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

function rowOf(element: RunTabs, runId: string): HTMLElement {
  const rows = [...(element.shadowRoot?.querySelectorAll('run-tab') ?? [])];
  const row = rows.find(
    (candidate) =>
      candidate.shadowRoot?.querySelector(
        `[data-run="${runId}"][data-action="select"]`,
      ) !== null,
  );
  if (!row) throw new Error(`no row for ${runId}`);
  return row as HTMLElement;
}

describe('run-tabs over the fold', () => {
  it('sends one run.delete for a repeated task-menu delete action', async () => {
    const base = fanOutView();
    const root = base.runs.get(ROOT);
    if (!root) throw new Error('no root run');
    const view: SessionView = {
      ...base,
      runs: new Map(base.runs).set(ROOT, { ...root, actions: ['delete'] }),
    };
    const { element, requests } = await mountTabs(
      view,
      emptySurface(view.key),
      { topLevelOnly: true, removable: true },
    );

    const menu = rowOf(element, ROOT).shadowRoot?.querySelector('.tab-actions');
    if (!menu) throw new Error('no task actions menu');
    const selectDelete = () =>
      menu.dispatchEvent(
        new CustomEvent('wa-select', {
          detail: { item: { value: 'delete' } },
        }),
      );
    selectDelete();
    selectDelete();
    expect(requests).toEqual([{ kind: 'run.delete', runId: ROOT }]);
  });
});
