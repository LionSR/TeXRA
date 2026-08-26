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

useLitComponentTestDom(
  () => import('@progressView/frontend/components/StreamTabs'),
);

interface StyledElementConstructor extends CustomElementConstructor {
  readonly elementStyles: readonly (
    CSSStyleSheet | { readonly cssText: string }
  )[];
}

function stream(
  name: string,
  agentCategory: AgentCategory = AgentCategory.ToolUse,
): StreamTabInfo {
  return {
    identity: { kind: 'agent', agent: name },
    name,
    label: name,
    agentCategory,
    creationTimestamp: 1,
  };
}

function makeBashChild(
  name: string,
  parentStreamId: string,
  creationTimestamp: number,
): StreamTabInfo {
  return {
    identity: { kind: 'process', tool: 'bash' },
    name,
    label: 'bash',
    parentStreamId,
    creationTimestamp,
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

async function mountTabs(props: Partial<StreamTabs>): Promise<StreamTabs> {
  const element = await mountComponent<StreamTabs>('stream-tabs', props);
  await settleChildRender();
  return element;
}

async function mountTabsWithStatuses(
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
  return mountTabs({ streams, streamStates, activeStreamId });
}

describe('stream-tab lifecycle distinction', () => {
  it('shows canonical lifecycle glyphs without redundant visible labels', async () => {
    const streams = [
      stream('running'),
      stream('waiting'),
      stream('completed'),
      stream('failed'),
      stream('cancelled'),
      stream('ready'),
    ];
    const tabs = await mountTabsWithStatuses(streams, [
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
    const tabs = await mountTabs({
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
    const tabs = await mountTabs({
      streams,
      streamStates,
      pendingApprovalStreamIds: new Set(['approval']),
      childStreamsByParent: new Map([
        ['starting', [{ ...stream('child'), parentStreamId: 'starting' }]],
      ]),
      compact: true,
    });
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
    const tabs = await mountTabs({
      streams: [stream('parent')],
      streamStates: new Map([['parent', streamState(STREAM_PHASE.RUNNING)]]),
      pendingApprovalStreamIds: new Set(['child']),
      childStreamsByParent: new Map([
        ['parent', [{ ...stream('child'), parentStreamId: 'parent' }]],
      ]),
      compact: true,
    });
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
    const tabs = await mountTabsWithStatuses(
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
    const tabs = await mountTabsWithStatuses(
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

describe('stream-tab expand chevron', () => {
  // The child-stream expand/collapse chevron uses the shared `wa-button`
  // action-icon pattern, and StreamTabs.handleTabClick delegates off
  // `[data-stream][data-action]`, so the element must carry both attributes.
  it('renders the expand toggle as a wa-button carrying the delegated-click contract', async () => {
    const tabs = await mountTabs({
      streams: [stream('parent', AgentCategory.Workflow)],
      childStreamsByParent: new Map([
        ['parent', [stream('child', AgentCategory.Workflow)]],
      ]),
    });
    const parentTab = tabs.shadowRoot?.querySelector('stream-tab');
    expect(parentTab).toBeTruthy();

    const expandButton = parentTab?.shadowRoot?.querySelector('.tab-expand');
    expect(expandButton).toBeTruthy();
    expect(expandButton?.tagName).toBe('WA-BUTTON');
    expect(expandButton?.getAttribute('data-stream')).toBe('parent');
    expect(expandButton?.getAttribute('data-action')).toBe('toggle-children');
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');
    expect(expandButton?.getAttribute('aria-label')).toBe('1 background task');
    expect(
      parentTab?.shadowRoot
        ?.querySelector('wa-tooltip[for="stream-tab-expand-button"]')
        ?.textContent?.trim(),
    ).toBe('1 background task');
  });

  it('expands ancestors when a child stream is the active session', async () => {
    const tabs = await mountTabs({
      streams: [stream('parent', AgentCategory.Workflow)],
      childStreamsByParent: new Map([
        ['parent', [stream('child', AgentCategory.Workflow)]],
      ]),
    });
    const parentTab = tabs.shadowRoot?.querySelector('stream-tab');
    const expandButton = parentTab?.shadowRoot?.querySelector('.tab-expand');
    expect(expandButton?.getAttribute('aria-expanded')).toBe('false');

    tabs.activeStreamId = 'child';
    await tabs.updateComplete;
    await settleChildRender();

    expect(
      parentTab?.shadowRoot
        ?.querySelector('.tab-expand')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(tabs.shadowRoot?.querySelectorAll('stream-tab')).toHaveLength(2);
  });

  it('identifies an unlabeled stream by name in the select aria-label', async () => {
    const tabs = await mountTabs({
      streams: [
        { ...stream('unlabeled-stream', AgentCategory.Workflow), label: '' },
      ],
    });

    const ariaLabel = tabs.shadowRoot
      ?.querySelector('stream-tab')
      ?.shadowRoot?.querySelector('#stream-tab-select-button')
      ?.getAttribute('aria-label');
    expect(ariaLabel).toContain('unlabeled-stream');
  });

  it('renders no session footer', async () => {
    const tabs = await mountTabs({
      streams: [stream('session', AgentCategory.Workflow)],
    });

    expect(tabs.shadowRoot?.querySelector('.stream-list-footer')).toBeNull();
    expect(tabs.shadowRoot?.querySelector('stream-tab')).toBeTruthy();
  });

  it('anchors the general hint to the title, not an ancestor of specific hints', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          ...stream('remote', AgentCategory.Workflow),
          isRemote: true,
          worktree: {
            workingDirectory: '/tmp/texra/remote',
            branch: 'remote',
          },
        },
      ],
    });

    const tab = tabs.shadowRoot?.querySelector('stream-tab');
    const shadow = tab?.shadowRoot;
    const title = shadow?.querySelector('#stream-tab-title');
    const select = shadow?.querySelector('#stream-tab-select-button');

    expect(
      shadow?.querySelector('wa-tooltip[for="stream-tab-select-button"]'),
    ).toBeNull();
    expect(
      shadow?.querySelector('wa-tooltip[for="stream-tab-title"]'),
    ).toBeNull();
    expect(select?.getAttribute('aria-label')).toContain('Status:');
    expect(
      title?.contains(shadow?.querySelector('#stream-tab-kind') ?? null),
    ).toBe(false);
    expect(
      title?.contains(shadow?.querySelector('#stream-tab-remote') ?? null),
    ).toBe(false);
    expect(
      title?.contains(shadow?.querySelector('worktree-chip') ?? null),
    ).toBe(false);

    tabs.compact = true;
    tabs.childStreamsByParent = new Map([
      ['remote', [stream('remote-child', AgentCategory.Workflow)]],
    ]);
    await tabs.updateComplete;
    await settleChildRender();

    const compactShadow =
      tabs.shadowRoot?.querySelector('stream-tab')?.shadowRoot;
    expect(
      compactShadow
        ?.querySelector('#stream-tab-title')
        ?.contains(compactShadow.querySelector('#stream-tab-compact-children')),
    ).toBe(false);
  });

  it('renders workflow scripts as orchestration streams without a model', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          identity: {
            kind: 'multiAgentWorkflow',
            workflowName: 'repo-cleanup-readonly-pilot-2026-07-24',
          },
          name: 'workflow-script#abc123',
          label: 'repo-cleanup-readonly-pilot-2026-07-24',
          agentCategory: AgentCategory.Workflow,
          creationTimestamp: 1,
        },
      ],
    });

    const tab = tabs.shadowRoot?.querySelector('stream-tab');
    const model = tab?.shadowRoot?.querySelector('.model');
    const kindIcon = tab?.shadowRoot?.querySelector('.stream-kind') as
      (Element & { name?: string }) | null;

    expect(model?.textContent?.trim()).toBe('');
    expect(kindIcon?.name).toBe('list-ul');
    expect(kindIcon?.hasAttribute('title')).toBe(false);
    expect(
      tab?.shadowRoot
        ?.querySelector('wa-tooltip[for="stream-tab-kind"]')
        ?.textContent?.trim(),
    ).toBe('Multi-Agent Workflow');
    expect(tab?.shadowRoot?.querySelector('.agent-name')).toBeNull();
  });

  it('surfaces the agent name inline on the metadata line when the title is a summary', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          ...stream('engineer', AgentCategory.Workflow),
          agentCategory: AgentCategory.ToolUse,
          description: 'Removing Supabase migrations from remote...',
          model: 'grok45',
          modelLabel: 'Grok 4.5',
        },
      ],
    });

    const shadow = tabs.shadowRoot?.querySelector('stream-tab')?.shadowRoot;
    expect(shadow?.querySelector('#stream-tab-title')?.textContent).toContain(
      'Removing Supabase migrations from remote...',
    );
    expect(shadow?.querySelector('.model')?.textContent?.trim()).toBe(
      'Grok 4.5',
    );
    expect(shadow?.querySelector('.agent-name')?.textContent?.trim()).toBe(
      'engineer',
    );
  });

  it('keeps the opaque stream id out of row text but in its accessible name', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          ...stream('review', AgentCategory.Workflow),
          name: 'review#a4c8939992cf',
          agentCategory: AgentCategory.ToolUse,
        },
      ],
    });

    const shadow = tabs.shadowRoot?.querySelector('stream-tab')?.shadowRoot;
    // Visible text carries the name only — never the hex suffix.
    expect(
      shadow?.querySelector('#stream-tab-title')?.textContent,
    ).not.toContain('a4c8939992cf');
    // The row summary stays aria-only by design (#9168) — no visual tooltip
    // spanning the row — but the id must still be in it, since that is what
    // separates two parallel runs of the same agent.
    expect(
      shadow
        ?.querySelector('#stream-tab-select-button')
        ?.getAttribute('aria-label'),
    ).toContain('review#a4c8939992cf');
  });

  it('omits the inline agent name when the title already is that same identity', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          ...stream('engineer', AgentCategory.Workflow),
          agentCategory: AgentCategory.ToolUse,
          // No `description`: the title falls back to the identity name
          // itself, so repeating it on the metadata line would just echo
          // the title back.
        },
      ],
    });

    const shadow = tabs.shadowRoot?.querySelector('stream-tab')?.shadowRoot;
    expect(shadow?.querySelector('#stream-tab-title')?.textContent).toContain(
      'engineer',
    );
    expect(shadow?.querySelector('.agent-name')).toBeNull();
  });

  it('hides finished process children from the Sessions tree', async () => {
    const parent = {
      ...stream('engineer', AgentCategory.Workflow),
      agentCategory: AgentCategory.ToolUse,
    };
    const liveBash = makeBashChild('bash@tool#live', 'engineer', 2);
    const doneBash = makeBashChild('bash@tool#done', 'engineer', 3);
    const tabs = await mountTabs({
      streams: [parent],
      childStreamsByParent: new Map([['engineer', [liveBash, doneBash]]]),
      streamStates: new Map([
        ['engineer', { status: 'running', lastTimestamp: 1 } as never],
        ['bash@tool#live', { status: 'running', lastTimestamp: 2 } as never],
        ['bash@tool#done', { status: 'completed', lastTimestamp: 3 } as never],
      ]),
    });

    const childTabs = [
      ...(tabs.shadowRoot?.querySelectorAll('.child-streams stream-tab') ?? []),
    ];
    expect(childTabs).toHaveLength(1);
    expect(
      childTabs[0]?.shadowRoot
        ?.querySelector('#stream-tab-title')
        ?.textContent?.trim(),
    ).toBe('bash');
  });
});
