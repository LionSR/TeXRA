// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { BackgroundTasksPanel } from '@progressView/frontend/components/BackgroundTasksPanel';
import type {
  inquiryThreadsContext as InquiryThreadsContext,
  phaseStagesContext as PhaseStagesContext,
} from '@progressView/frontend/streamContexts';
import type { StreamTabId } from '@shared/schemas';

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
    const element = createPanel();
    element.subagents = [
      {
        executionId: 'exec-1',
        childStreamId: 'child-1',
        agentName: 'reviewer',
        identity: { kind: 'agent' as const, agent: 'reviewer' },
        status: 'running',
        elapsed: '12s',
      },
      {
        executionId: 'exec-2',
        childStreamId: 'child-2',
        agentName: 'polisher',
        identity: { kind: 'agent' as const, agent: 'polisher' },
        status: 'completed',
        elapsed: '1m 4s',
        finishedAt: 1_000,
      },
    ];
    document.body.append(element);
    await element.updateComplete;

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
    expect(badges).toEqual(['Running', 'Finished']);
    expect(shadow.textContent).not.toContain('completed</em>');
    expect(shadow.textContent).not.toMatch(/All \d+ subagents completed/);

    // A lone populated section renders rows directly — no section header, so
    // per-row status badges are the status surface.

    element.remove();
  });

  it('labels a running workflow-script row with its current phase', async () => {
    const element = createPanel();
    element.subagents = [
      {
        executionId: 'exec-run',
        childStreamId: 'workflow-run',
        agentName: 'workflow-script',
        identity: { kind: 'agent' as const, agent: 'workflow-script' },
        status: 'running',
      },
      {
        executionId: 'exec-plain',
        childStreamId: 'plain-child',
        agentName: 'reviewer',
        identity: { kind: 'agent' as const, agent: 'reviewer' },
        status: 'running',
      },
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
    const element = createPanel();
    element.subagents = [
      {
        executionId: 'subagent-1',
        childStreamId: 'child-1',
        agentName: 'reviewer',
        identity: { kind: 'agent' as const, agent: 'reviewer' },
        status: 'running',
        finishedAt: 1_000,
      },
    ];
    document.body.append(element);
    await element.updateComplete;

    const badge = element.shadowRoot?.querySelector('wa-badge.task-status');
    expect(badge?.textContent).toBe('Running');
    expect(badge?.getAttribute('variant')).toBe('warning');

    element.remove();
  });

  it('does not paint a retained process green when no terminal status arrived', async () => {
    const element = createPanel();
    element.subagents = [
      {
        executionId: 'bash-1',
        childStreamId: 'child-bash',
        agentName: 'bash',
        identity: { kind: 'process' as const, tool: 'bash' },
        // A process has no child status source, so its retained row can keep
        // the last in-flight phase. Claiming success here would render a
        // failed command green.
        status: 'running',
        finishedAt: 1_000,
      },
    ];
    document.body.append(element);
    await element.updateComplete;

    const badge = element.shadowRoot?.querySelector('wa-badge.task-status');
    expect(badge?.getAttribute('variant')).toBe('neutral');

    element.remove();
  });

  it('paints a retained process green only on an explicit completed status', async () => {
    const element = createPanel();
    element.subagents = [
      {
        executionId: 'bash-2',
        childStreamId: 'child-bash-2',
        agentName: 'bash',
        identity: { kind: 'process' as const, tool: 'bash' },
        status: 'completed',
        finishedAt: 1_000,
      },
    ];
    document.body.append(element);
    await element.updateComplete;

    const badge = element.shadowRoot?.querySelector('wa-badge.task-status');
    expect(badge?.textContent).toBe('Finished');
    expect(badge?.getAttribute('variant')).toBe('success');

    element.remove();
  });

  it('shows a failed retained process as failed', async () => {
    const element = createPanel();
    element.subagents = [
      {
        executionId: 'bash-3',
        childStreamId: 'child-bash-3',
        agentName: 'bash',
        identity: { kind: 'process' as const, tool: 'bash' },
        status: 'failed',
        finishedAt: 1_000,
      },
    ];
    document.body.append(element);
    await element.updateComplete;

    const badge = element.shadowRoot?.querySelector('wa-badge.task-status');
    expect(badge?.textContent).toBe('Failed');
    expect(badge?.getAttribute('variant')).toBe('danger');

    element.remove();
  });

  it('shows inquiries without workflow subagents in inquiry scope', async () => {
    const element = createPanel();
    element.scope = 'inquiries';
    element.subagents = [
      {
        executionId: 'exec-1',
        childStreamId: 'child-1',
        agentName: 'reviewer',
        identity: { kind: 'agent' as const, agent: 'reviewer' },
        status: 'running',
      },
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
