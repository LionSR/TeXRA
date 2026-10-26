// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { RunHeader } from '@progressView/frontend/components/RunHeader';
import { ELEMENT_IDS } from '@progressView/frontend/constants';
import { RUN_PHASE, RUN_SUBSTATE, type RunId } from '@shared/schemas';
import { runActions } from '@shared/session/runActions';
import type { SessionView, RunView } from '@shared/session/sessionView';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { fanOutView, ROOT } from '@test/shared/session/fanOutScenario';
import type { SurfaceAction } from '@texra/shared/session/surface';
import type { HostRequest } from '@texra/shared/session/hostRequest';

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

async function mountHeader(view: SessionView, run: RunView): Promise<Mounted> {
  const element = await mountComponent<RunHeader>('run-header', {
    view,
    run,
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

describe('run-header over the fold', () => {
  it('offers deleting a workflow run’s output files only once it has stopped', async () => {
    const view = fanOutView();
    const root = runOfEvent(view, ROOT);
    const cleanOffered = async (over: Partial<RunView>): Promise<boolean> => {
      const fields = {
        ...root,
        identity: { kind: 'agent', agent: 'correct' },
        recipe: 'task',
        ...over,
      } as RunView;
      const { element } = await mountHeader(view, {
        ...fields,
        actions: runActions(fields, false),
      });
      return (
        element.shadowRoot?.querySelector(
          `wa-dropdown-item[value="${ELEMENT_IDS.CLEAN_STREAM_BTN}"]`,
        ) != null
      );
    };
    expect(root.group).toBe('running');
    expect(await cleanOffered({})).toBe(false);
    // Starting was the hole: the header used to enable it there.
    expect(await cleanOffered({ substate: RUN_SUBSTATE.STARTING })).toBe(false);
    expect(
      await cleanOffered({ status: RUN_PHASE.COMPLETED, group: 'recent' }),
    ).toBe(true);
  });
});
