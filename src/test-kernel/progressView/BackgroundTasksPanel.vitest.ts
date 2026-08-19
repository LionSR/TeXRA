// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { BackgroundTasksPanel } from '@progressView/frontend/components/BackgroundTasksPanel';
import type {
  inquiryThreadsContext as InquiryThreadsContext,
  phaseStagesContext as PhaseStagesContext,
} from '@progressView/frontend/streamContexts';
import type { ActiveChildInfo, StreamTabId } from '@shared/schemas';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';
import type { ContextProvider } from '@lit/context';

interface StyledBackgroundTasksPanelConstructor extends CustomElementConstructor {
  readonly elementStyles: readonly (
    CSSStyleSheet | { readonly cssText: string }
  )[];
}

// @lit/context captures the global Event constructor at module scope, so it
// and the context definitions can only be imported after the test DOM globals
// are installed (that is what useLitComponentTestDom's hook does).
let ContextProviderCtor: typeof ContextProvider;
let inquiryThreadsContext: typeof InquiryThreadsContext;
let phaseStagesContext: typeof PhaseStagesContext;

function createPanel(): BackgroundTasksPanel {
  return document.createElement(
    'background-tasks-panel',
  ) as BackgroundTasksPanel;
}

/** A roster row; defaults to a running `reviewer` agent child. */
function subagentRow(overrides: {
  executionId: string;
  childStreamId?: string;
  agentName?: string;
  status?: ActiveChildInfo['status'];
  startedAt?: number;
  finishedAt?: number;
  processTool?: string;
}): ActiveChildInfo {
  const agentName = overrides.agentName ?? 'reviewer';
  return {
    executionId: overrides.executionId,
    childStreamId: overrides.childStreamId ?? `child-${overrides.executionId}`,
    agentName,
    identity: overrides.processTool
      ? { kind: 'process', tool: overrides.processTool }
      : { kind: 'agent', agent: agentName },
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt,
  };
}

async function mountPanel(
  subagents: ActiveChildInfo[],
): Promise<BackgroundTasksPanel> {
  const element = createPanel();
  element.subagents = subagents;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe('background-tasks-panel', () => {
  useLitComponentTestDom(async () => {
    ({ ContextProvider: ContextProviderCtor } = await import('@lit/context'));
    ({ inquiryThreadsContext, phaseStagesContext } =
      await import('@progressView/frontend/streamContexts'));
    await import('@progressView/frontend/components/BackgroundTasksPanel');
  });

  it('strips the redundant Web Awesome card around its contents', () => {
    const element = createPanel();
    const constructor =
      element.constructor as StyledBackgroundTasksPanelConstructor;
    const styleText = constructor.elementStyles
      .map((style) => {
        if ('cssText' in style) return style.cssText;
        return [...style.cssRules].map((rule) => rule.cssText).join('\n');
      })
      .join('\n');
    const styleElement = document.createElement('style');
    styleElement.textContent = styleText;
    document.head.append(styleElement);

    const rule = [...(styleElement.sheet?.cssRules ?? [])].find(
      (candidate) =>
        (candidate as CSSStyleRule).selectorText ===
        'wa-details.panel-collapsible::part(base)',
    ) as CSSStyleRule | undefined;
    styleElement.remove();

    expect(rule).toBeDefined();
    expect(rule?.style.background).toBe('transparent');
    expect(rule?.style.borderStyle).toBe('none');
    expect(rule?.style.borderRadius).toBe('0px');
  });

  it('lists a retained finished subagent as a named row, not a count', async () => {
    const element = await mountPanel([
      subagentRow({ executionId: 'exec-1', startedAt: 1_000 }),
      subagentRow({
        executionId: 'exec-2',
        agentName: 'polisher',
        status: 'completed',
        startedAt: 1_000,
        finishedAt: 65_000,
      }),
    ]);

    const shadow = element.shadowRoot!;
    const names = [...shadow.querySelectorAll('.task-name')].map(
      (node) => node.textContent,
    );
    expect(names).toEqual(['reviewer', 'polisher']);
    for (const name of shadow.querySelectorAll<HTMLElement>('.task-name')) {
      expect(name.hasAttribute('title')).toBe(false);
      expect(shadow.querySelector(`wa-tooltip[for="${name.id}"]`)).toBeTruthy();
    }

    const rows = [...shadow.querySelectorAll('.task-header')];
    expect(rows.at(-1)?.textContent).toContain('1m 4s');
    const badges = [...shadow.querySelectorAll('wa-badge.task-status')].map(
      (node) => node.textContent,
    );
    // Same progressHeader vocabulary as stream tabs (Completed, not Finished).
    expect(badges).toEqual(['Running', 'Completed']);
    expect(shadow.textContent).not.toContain('completed</em>');
    expect(shadow.textContent).not.toMatch(/All \d+ subagents completed/);

    element.remove();
  });

  it('labels a running workflow-script row with its current phase', async () => {
    const element = createPanel();
    element.subagents = [
      subagentRow({
        executionId: 'exec-run',
        childStreamId: 'workflow-run',
        agentName: 'workflow-script',
      }),
      subagentRow({ executionId: 'exec-plain', childStreamId: 'plain-child' }),
    ];
    const container = document.createElement('div');
    document.body.append(container);
    // A plain (non-ReactiveElement) provider host must be connected by hand.
    new ContextProviderCtor(container, {
      context: phaseStagesContext,
      initialValue: new Map([
        [
          'workflow-run' as StreamTabId,
          { label: 'Reduce', index: 1, total: 3 },
        ],
      ]),
    }).hostConnected();
    container.append(element);
    await element.updateComplete;

    const shadow = element.shadowRoot!;
    const phases = [...shadow.querySelectorAll('.task-phase')].map(
      (node) => node.textContent,
    );
    // Only the run carries a phase; a stream without one gains no span.
    expect(phases).toEqual(['Reduce 2/3']);
    const rows = [...shadow.querySelectorAll('.task-header')];
    expect(rows[0]?.textContent).toContain('Reduce 2/3');
    expect(rows[1]?.textContent).not.toContain('Reduce');

    container.remove();
  });

  it('does not show success while a retained subagent status still lags', async () => {
    const element = await mountPanel([
      subagentRow({
        executionId: 'subagent-1',
        childStreamId: 'child-1',
        finishedAt: 1_000,
      }),
    ]);

    const badge = element.shadowRoot?.querySelector('wa-badge.task-status');
    expect(badge?.textContent).toBe('Running');
    // Running uses the stream-tab success green, not the workflow warning yellow.
    expect(badge?.getAttribute('variant')).toBe('success');

    element.remove();
  });

  it('uses the same lifecycle wording as stream tabs for terminal rows', async () => {
    const element = await mountPanel([
      subagentRow({
        executionId: 'done',
        status: 'completed',
        finishedAt: 1_000,
      }),
      subagentRow({
        executionId: 'stopped',
        agentName: 'stopped-agent',
        status: 'cancelled',
        finishedAt: 1_000,
      }),
      subagentRow({
        executionId: 'failed',
        agentName: 'failed-agent',
        status: 'failed',
        finishedAt: 1_000,
      }),
      subagentRow({
        executionId: 'idle',
        agentName: 'idle-agent',
        status: 'waiting',
      }),
    ]);

    const badges = [
      ...(element.shadowRoot?.querySelectorAll('wa-badge.task-status') ?? []),
    ].map((node) => ({
      text: node.textContent,
      variant: node.getAttribute('variant'),
    }));
    expect(badges).toEqual([
      { text: 'Completed', variant: 'success' },
      { text: 'Stopped', variant: 'neutral' },
      { text: 'Error', variant: 'danger' },
      { text: 'Idle', variant: 'brand' },
    ]);

    element.remove();
  });

  it('does not render finished process children — they are ephemeral', async () => {
    const element = await mountPanel([
      subagentRow({
        executionId: 'bash-1',
        childStreamId: 'child-bash',
        agentName: 'bash',
        processTool: 'bash',
        status: 'completed',
        finishedAt: 1_000,
      }),
      subagentRow({
        executionId: 'agent-1',
        childStreamId: 'child-agent',
        status: 'completed',
        finishedAt: 1_000,
      }),
    ]);

    const names = [
      ...(element.shadowRoot?.querySelectorAll('.task-name') ?? []),
    ].map((node) => node.textContent?.trim());
    expect(names).toEqual(['reviewer']);
    expect(
      element.shadowRoot?.querySelector('wa-badge.task-status'),
    ).toBeTruthy();

    element.remove();
  });

  it('still lists a live process child', async () => {
    const element = await mountPanel([
      subagentRow({
        executionId: 'bash-live',
        childStreamId: 'child-bash-live',
        agentName: 'bash',
        processTool: 'bash',
      }),
    ]);

    expect(
      element.shadowRoot?.querySelector('.task-name')?.textContent?.trim(),
    ).toBe('bash');
    expect(
      element.shadowRoot?.querySelector('wa-badge.task-status')?.textContent,
    ).toBe('Running');

    element.remove();
  });

  it('shows inquiries without workflow subagents in inquiry scope', async () => {
    const element = createPanel();
    element.scope = 'inquiries';
    element.subagents = [
      subagentRow({ executionId: 'exec-1', childStreamId: 'child-1' }),
    ];
    const container = document.createElement('div');
    document.body.append(container);
    new ContextProviderCtor(container, {
      context: inquiryThreadsContext,
      initialValue: [
        {
          threadId: 'inquiry-1',
          parentStreamId: null,
          status: 'open',
          lastQuestionPreview: 'Which boundary condition is intended?',
          lastActivityIso: '2026-07-28T12:00:00.000Z',
          turnCount: 1,
        },
      ],
    }).hostConnected();
    container.append(element);
    await element.updateComplete;

    const shadow = element.shadowRoot!;
    expect(shadow.querySelector('wa-details')?.getAttribute('summary')).toBe(
      'Inquiries',
    );
    expect(shadow.querySelector('.inquiry-id')?.textContent).toBe('inquiry-1');
    expect(shadow.querySelector('.task-name')).toBeNull();

    container.remove();
  });
});
