// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';
import {
  AgentCategory,
  createStreamState,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  type StreamLifecycleStatus,
  type StreamState,
  type StreamTabInfo,
} from '@shared/schemas';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

interface StyledElementConstructor extends CustomElementConstructor {
  readonly elementStyles: readonly (
    CSSStyleSheet | { readonly cssText: string }
  )[];
}

function stream(name: string): StreamTabInfo {
  return {
    identity: { kind: 'agent', agent: name },
    name,
    label: name,
    agentCategory: AgentCategory.ToolUse,
    creationTimestamp: 1,
  };
}

function streamState(status: StreamLifecycleStatus): StreamState {
  return createStreamState(AgentCategory.ToolUse, { status });
}

function styleText(element: Element): string {
  const constructor = element.constructor as StyledElementConstructor;
  return constructor.elementStyles
    .map((style) => {
      if ('cssText' in style) return style.cssText;
      return [...style.cssRules].map((rule) => rule.cssText).join('\n');
    })
    .join('\n');
}

/** Let the nested <stream-tab> finish its own first render. */
function settleChildRender(): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountTabs(
  streams: StreamTabInfo[],
  statuses: readonly StreamLifecycleStatus[],
  activeStreamId: string | null = null,
): Promise<StreamTabs> {
  const streamStates = new Map(
    streams.map((item, index) => [
      item.name,
      streamState(statuses[index] ?? STREAM_PHASE.RUNNING),
    ]),
  );
  const tabs = await mountComponent<StreamTabs>('stream-tabs', {
    streams,
    streamStates,
    activeStreamId,
  });
  await settleChildRender();
  return tabs;
}

describe('stream-tab lifecycle distinction', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/StreamTabs'),
  );

  it('shows canonical lifecycle glyphs without redundant visible labels', async () => {
    const streams = [
      stream('running'),
      stream('waiting'),
      stream('completed'),
      stream('failed'),
      stream('cancelled'),
      stream('ready'),
    ];
    const tabs = await mountTabs(streams, [
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.WAITING,
      STREAM_PHASE.COMPLETED,
      STREAM_PHASE.FAILED,
      STREAM_PHASE.CANCELLED,
      STREAM_STATUS.READY,
    ]);
    const rows = [...(tabs.shadowRoot?.querySelectorAll('stream-tab') ?? [])];
    const labels = [
      'Running',
      'Idle',
      'Completed',
      'Error',
      'Stopped',
      'Ready',
    ];

    expect(
      rows.map((row) => row.shadowRoot?.querySelector('.tab-status-label')),
    ).toEqual([null, null, null, null, null, null]);
    expect(
      rows.map(
        (row) =>
          (
            row.shadowRoot?.querySelector('.tab-status-icon') as
              (Element & { name?: string }) | null
          )?.name,
      ),
    ).toEqual([
      'play',
      'clock',
      'circle-check',
      'circle-exclamation',
      'circle-stop',
      'circle',
    ]);

    const containers = rows.map((row) =>
      row.shadowRoot?.querySelector('.tab-container'),
    );
    expect(containers[0]?.classList.contains('status-running')).toBe(true);
    expect(containers[1]?.classList.contains('status-waiting')).toBe(true);
    expect(containers[2]?.classList.contains('status-completed')).toBe(true);
    expect(containers[3]?.classList.contains('status-failed')).toBe(true);
    expect(containers[4]?.classList.contains('status-cancelled')).toBe(true);
    expect(containers[5]?.classList.contains('status-ready')).toBe(true);

    rows.forEach((row, index) => {
      const label = labels[index];
      expect(
        row.shadowRoot
          ?.querySelector('#stream-tab-select-button')
          ?.getAttribute('aria-label'),
      ).toContain(`Status: ${label}`);
      expect(
        row.shadowRoot
          ?.querySelector('#stream-tab-status')
          ?.getAttribute('aria-label'),
      ).toBe(label);
      expect(
        row.shadowRoot
          ?.querySelector('wa-tooltip[for="stream-tab-status"]')
          ?.textContent?.trim(),
      ).toBe(label);
    });
  });

  it('keeps an unknown lifecycle value visible as its defensive fallback', async () => {
    const item = stream('unknown');
    const tabs = await mountComponent<StreamTabs>('stream-tabs', {
      streams: [item],
      streamStates: new Map([
        [
          item.name,
          {
            ...streamState(STREAM_PHASE.RUNNING),
            status: 'paused-by-host',
          } as unknown as StreamState,
        ],
      ]),
    });
    await settleChildRender();
    const row = tabs.shadowRoot?.querySelector('stream-tab');

    expect(
      row?.shadowRoot?.querySelector('.tab-status-label')?.textContent?.trim(),
    ).toBe('paused-by-host');
    expect(
      row?.shadowRoot
        ?.querySelector('#stream-tab-select-button')
        ?.getAttribute('aria-label'),
    ).toContain('Status: paused-by-host');
    expect(
      row?.shadowRoot
        ?.querySelector('.tab-container')
        ?.classList.contains('status-paused-by-host'),
    ).toBe(true);
  });

  it('keeps starting, resuming, and approval cues accessible in the collapsed rail', async () => {
    const streams = [
      stream('starting'),
      stream('resuming'),
      stream('approval'),
    ];
    const streamStates = new Map([
      [
        'starting',
        createStreamState(AgentCategory.ToolUse, {
          status: STREAM_PHASE.RUNNING,
          substate: STREAM_SUBSTATE.STARTING,
        }),
      ],
      [
        'resuming',
        createStreamState(AgentCategory.ToolUse, {
          status: STREAM_PHASE.RUNNING,
          substate: STREAM_SUBSTATE.RESUMING,
        }),
      ],
      ['approval', streamState(STREAM_PHASE.RUNNING)],
    ]);
    const tabs = await mountComponent<StreamTabs>('stream-tabs', {
      streams,
      streamStates,
      pendingApprovalStreamIds: new Set(['approval']),
      childStreamsByParent: new Map([
        ['starting', [{ ...stream('child'), parentStreamId: 'starting' }]],
      ]),
      compact: true,
    });
    await settleChildRender();
    const rows = [...(tabs.shadowRoot?.querySelectorAll('stream-tab') ?? [])];

    expect(
      rows.map((row) => row.shadowRoot?.querySelector('.tab-status-label')),
    ).toEqual([null, null, null]);
    expect(
      rows.map((row) =>
        row.shadowRoot
          ?.querySelector('wa-tooltip[for="stream-tab-status"]')
          ?.textContent?.trim(),
      ),
    ).toEqual(['Initializing', 'Resuming', 'Approval required']);
    expect(
      rows.map(
        (row) =>
          (
            row.shadowRoot?.querySelector('.tab-status-icon') as
              (Element & { name?: string }) | null
          )?.name,
      ),
    ).toEqual(['spinner', 'spinner', 'triangle-exclamation']);
    expect(
      rows[2]?.shadowRoot
        ?.querySelector('#stream-tab-select-button')
        ?.getAttribute('aria-label'),
    ).toContain('Status: Approval required');
    const startingSelect = rows[0]?.shadowRoot?.querySelector(
      '#stream-tab-select-button',
    );
    expect(
      rows[0]?.shadowRoot?.querySelector('.compact-subagent-hint'),
    ).toBeNull();
    const identityTooltip = rows[0]?.shadowRoot?.querySelector<HTMLElement>(
      'wa-tooltip[for="stream-tab-select-tooltip-anchor"]',
    );
    await (identityTooltip as HTMLElement & { updateComplete?: Promise<void> })
      ?.updateComplete;
    const tooltipAnchor = rows[0]?.shadowRoot?.querySelector(
      '#stream-tab-select-tooltip-anchor',
    );
    expect(identityTooltip?.textContent?.trim()).toBe('starting');
    expect(
      tooltipAnchor?.getAttribute('aria-labelledby')?.split(/\s+/),
    ).toContain(identityTooltip?.id);
    expect(startingSelect?.getAttribute('aria-labelledby')).toBeNull();
    const accessibleLabel = startingSelect?.getAttribute('aria-label');
    expect(accessibleLabel).toContain('starting');
    expect(accessibleLabel).toContain('Status: Initializing');
    expect(accessibleLabel).toContain('1 background task');
    const compactStyles = styleText(rows[0]!);
    expect(compactStyles).toContain(
      '.tab-container.is-compact .tab-status-label',
    );
    expect(compactStyles).toContain('min-inline-size: 1em');
    expect(compactStyles).toContain('max-width: none');
  });

  it('surfaces a descendant approval on the compact parent row', async () => {
    const tabs = await mountComponent<StreamTabs>('stream-tabs', {
      streams: [stream('parent')],
      streamStates: new Map([['parent', streamState(STREAM_PHASE.RUNNING)]]),
      pendingApprovalStreamIds: new Set(['child']),
      childStreamsByParent: new Map([
        ['parent', [{ ...stream('child'), parentStreamId: 'parent' }]],
      ]),
      compact: true,
    });
    await settleChildRender();
    const row = tabs.shadowRoot?.querySelector('stream-tab');

    expect(
      row?.shadowRoot
        ?.querySelector('.tab-container')
        ?.classList.contains('has-pending-approval'),
    ).toBe(true);
    expect(
      (
        row?.shadowRoot?.querySelector('.tab-status-icon') as
          (Element & { name?: string }) | null
      )?.name,
    ).toBe('triangle-exclamation');
    expect(
      row?.shadowRoot
        ?.querySelector('#stream-tab-select-button')
        ?.getAttribute('aria-label'),
    ).toContain('Status: Approval required');
  });

  it('keeps selection primary while retaining the accessible lifecycle label', async () => {
    const tabs = await mountTabs(
      [stream('selected-running'), stream('selected-stopped')],
      [STREAM_PHASE.RUNNING, STREAM_PHASE.CANCELLED],
      'selected-running',
    );
    const rows = [...(tabs.shadowRoot?.querySelectorAll('stream-tab') ?? [])];
    const selected = rows[0]?.shadowRoot?.querySelector('.tab-container');

    expect(selected?.classList.contains('is-active')).toBe(true);
    expect(selected?.classList.contains('status-running')).toBe(true);
    expect(selected?.querySelector('.tab-status-label')).toBeNull();
    expect(
      selected?.querySelector('#stream-tab-status')?.getAttribute('aria-label'),
    ).toBe('Running');
    expect(
      rows[1]?.shadowRoot
        ?.querySelector('.tab-container')
        ?.classList.contains('is-active'),
    ).toBe(false);
    const select = rows[0]?.shadowRoot?.querySelector<HTMLElement>(
      '#stream-tab-select-button',
    );
    select?.focus();
    expect(rows[0]?.shadowRoot?.activeElement).toBe(select);
    expect(styleText(tabs)).not.toContain('stream-tab.is-finished');
  });

  it('preserves long-title truncation, status indicators, semantic tokens, and forced-color overrides', async () => {
    const tabs = await mountTabs(
      [
        stream(
          'a very long execution label that must yield space to lifecycle status',
        ),
      ],
      [STREAM_PHASE.COMPLETED],
    );
    const row = tabs.shadowRoot?.querySelector('stream-tab');
    expect(row).toBeTruthy();
    const styles = styleText(row!);

    expect(styles).toContain('.tab-title');
    expect(styles).toContain('min-width: 0');
    expect(styles).toContain('text-overflow: ellipsis');
    expect(styles).toContain('.tab-status');
    expect(styles).toContain('flex-shrink: 0');
    expect(styles).toContain('var(--color-success)');
    expect(styles).toContain('var(--color-error)');
    expect(styles).toContain('var(--color-text-muted)');
    expect(styles).toContain('@media (forced-colors: active)');
    expect(styles).toContain('--stream-status-color: Highlight');
    expect(styles).toContain('--stream-status-color: CanvasText');
    expect(styles).toContain('--stream-status-color: GrayText');
    expect(styles).toContain('--stream-status-rail-color: transparent');
    expect(styles).not.toContain('--stream-status-rail-color: GrayText');
    expect(styles).toContain(
      'var(--stream-status-rail-color, var(--stream-status-color, transparent))',
    );
    for (const status of [
      'running',
      'waiting',
      'starting',
      'resuming',
      'failed',
      'error',
    ]) {
      expect(styles).toContain(`.tab-container.status-${status}`);
    }
    expect(styles).toContain('.tab-container.is-active:is(');
    expect(styles).toContain('--stream-status-rail-color: HighlightText');
    expect(styles).toContain('background-color: Highlight');
    expect(styles).toContain('color: HighlightText');
    expect(styles).toContain('.tab-container.is-active *');
    expect(styles).not.toContain('outline: none');
    expect(row?.shadowRoot?.querySelector('.tab-status-label')).toBeNull();
    expect(
      row?.shadowRoot
        ?.querySelector('#stream-tab-status')
        ?.getAttribute('aria-label'),
    ).toBe('Completed');
  });
});
