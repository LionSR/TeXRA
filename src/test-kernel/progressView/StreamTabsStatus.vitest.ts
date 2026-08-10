// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';
import type { StreamState } from '@progressView/frontend/store';
import {
  AgentCategory,
  createStreamState,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  type StreamLifecycleStatus,
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
  await new Promise((resolve) => setTimeout(resolve, 0));
  return tabs;
}

describe('stream-tab lifecycle distinction', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/StreamTabs'),
  );

  it('shows every canonical lifecycle state with text and distinct glyphs', async () => {
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

    expect(
      rows.map((row) =>
        row.shadowRoot?.querySelector('.tab-status-label')?.textContent?.trim(),
      ),
    ).toEqual(['Running', 'Idle', 'Completed', 'Error', 'Stopped', 'Ready']);
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

    for (const row of rows) {
      expect(
        row.shadowRoot
          ?.querySelector('#stream-tab-select-button')
          ?.getAttribute('aria-label'),
      ).toContain('Status:');
      expect(
        row.shadowRoot
          ?.querySelector('.tab-status')
          ?.getAttribute('aria-hidden'),
      ).toBe('true');
    }
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = [...(tabs.shadowRoot?.querySelectorAll('stream-tab') ?? [])];

    expect(
      rows.map((row) =>
        row.shadowRoot?.querySelector('.tab-status-label')?.textContent?.trim(),
      ),
    ).toEqual(['Initializing', 'Resuming', 'Approval']);
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
    expect(
      rows[0]?.shadowRoot
        ?.querySelector('#stream-tab-select-button')
        ?.getAttribute('aria-label'),
    ).toContain('1 background task');
    expect(
      rows[0]?.shadowRoot?.querySelector('.compact-subagent-hint'),
    ).toBeNull();
    const compactStyles = styleText(rows[0]!);
    expect(compactStyles).toContain(
      '.tab-container.is-compact .tab-status-label',
    );
    expect(compactStyles).toContain('min-inline-size: 1em');
    expect(compactStyles).toContain('max-width: none');
  });

  it('keeps selection primary without removing the visible lifecycle label', async () => {
    const tabs = await mountTabs(
      [stream('selected-running'), stream('selected-stopped')],
      [STREAM_PHASE.RUNNING, STREAM_PHASE.CANCELLED],
      'selected-running',
    );
    const rows = [...(tabs.shadowRoot?.querySelectorAll('stream-tab') ?? [])];
    const selected = rows[0]?.shadowRoot?.querySelector('.tab-container');

    expect(selected?.classList.contains('is-active')).toBe(true);
    expect(selected?.classList.contains('status-running')).toBe(true);
    expect(
      selected?.querySelector('.tab-status-label')?.textContent?.trim(),
    ).toBe('Running');
    expect(
      rows[1]?.shadowRoot
        ?.querySelector('.tab-container')
        ?.classList.contains('is-active'),
    ).toBe(false);
    expect(styleText(tabs)).not.toContain('stream-tab.is-finished');
  });

  it('preserves long-title truncation, status text, semantic tokens, and forced-color overrides', async () => {
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
    expect(styles).not.toContain('--stream-status-rail-color: GrayText');
    expect(styles).toContain('.tab-container.is-active:is(');
    expect(styles).toContain('--stream-status-rail-color: HighlightText');
    expect(styles).toContain('background-color: Highlight');
    expect(styles).toContain('color: HighlightText');
    expect(styles).not.toContain('outline: none');
    expect(
      row?.shadowRoot?.querySelector('.tab-status-label')?.textContent?.trim(),
    ).toBe('Completed');
  });
});
