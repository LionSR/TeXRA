// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { StreamTabs } from '@progressView/frontend/components/StreamTabs';
import { AgentCategory, type StreamTabInfo } from '@shared/schemas';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

function makeStream(name: string): StreamTabInfo {
  return {
    identity: { kind: 'agent', agent: name },
    name,
    label: name,
    agentCategory: AgentCategory.Workflow,
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

/** Let the nested <stream-tab> finish its own first render. */
function settleChildRender(): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountTabs(props: Partial<StreamTabs>): Promise<StreamTabs> {
  const element = await mountComponent<StreamTabs>('stream-tabs', props);
  await settleChildRender();
  return element;
}

describe('stream-tab expand chevron', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/StreamTabs'),
  );

  // The child-stream expand/collapse chevron uses the shared `wa-button`
  // action-icon pattern, and StreamTabs.handleTabClick delegates off
  // `[data-stream][data-action]`, so the element must carry both attributes.
  it('renders the expand toggle as a wa-button carrying the delegated-click contract', async () => {
    const tabs = await mountTabs({
      streams: [makeStream('parent')],
      childStreamsByParent: new Map([['parent', [makeStream('child')]]]),
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
      streams: [makeStream('parent')],
      childStreamsByParent: new Map([['parent', [makeStream('child')]]]),
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
      streams: [{ ...makeStream('unlabeled-stream'), label: '' }],
    });

    const ariaLabel = tabs.shadowRoot
      ?.querySelector('stream-tab')
      ?.shadowRoot?.querySelector('#stream-tab-select-button')
      ?.getAttribute('aria-label');
    expect(ariaLabel).toContain('unlabeled-stream');
  });

  it('renders no session footer', async () => {
    const tabs = await mountTabs({ streams: [makeStream('session')] });

    expect(tabs.shadowRoot?.querySelector('.stream-list-footer')).toBeNull();
    expect(tabs.shadowRoot?.querySelector('stream-tab')).toBeTruthy();
  });

  it('anchors the general hint to the title, not an ancestor of specific hints', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          ...makeStream('remote'),
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
      ['remote', [makeStream('remote-child')]],
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
          ...makeStream('engineer'),
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

  it('reads the inline agent name from RunIdentity, not the derived tab label', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          identity: { kind: 'agent', agent: 'custom:engineer' },
          name: 'custom:engineer#abc',
          // Deliberately stale/wrong derived label — identity is authoritative.
          label: 'stale-label',
          agentCategory: AgentCategory.ToolUse,
          description: 'Removing Supabase migrations from remote...',
          creationTimestamp: 1,
        },
      ],
    });

    expect(
      tabs.shadowRoot
        ?.querySelector('stream-tab')
        ?.shadowRoot?.querySelector('.agent-name')
        ?.textContent?.trim(),
    ).toBe('engineer');
  });

  it('keeps the opaque stream id out of row text but in its accessible name', async () => {
    const tabs = await mountTabs({
      streams: [
        {
          ...makeStream('review'),
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
          ...makeStream('engineer'),
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
      ...makeStream('engineer'),
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
