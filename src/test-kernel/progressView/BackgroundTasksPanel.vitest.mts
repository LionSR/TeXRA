// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { BackgroundTasksPanel } from '@progressView/frontend/components/BackgroundTasksPanel';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

interface StyledBackgroundTasksPanelConstructor extends CustomElementConstructor {
  readonly elementStyles: readonly (
    CSSStyleSheet | { readonly cssText: string }
  )[];
}

describe('background-tasks-panel', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/BackgroundTasksPanel'),
  );

  it('strips the redundant Web Awesome card around its contents', () => {
    const element = document.createElement(
      'background-tasks-panel',
    ) as BackgroundTasksPanel;
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
    const element = document.createElement(
      'background-tasks-panel',
    ) as BackgroundTasksPanel;
    element.subagents = [
      {
        kind: 'subagent',
        executionId: 'exec-1',
        childStreamId: 'child-1',
        agentName: 'reviewer',
        status: 'running',
        elapsed: '12s',
      },
      {
        kind: 'subagent',
        executionId: 'exec-2',
        childStreamId: 'child-2',
        agentName: 'polisher',
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

    const rows = [...shadow.querySelectorAll('.task-item')];
    expect(rows.at(-1)?.textContent).toContain('1m 4s');
    const badges = [...shadow.querySelectorAll('wa-badge.task-status')].map(
      (node) => node.textContent,
    );
    expect(badges).toEqual(['running', 'completed']);
    expect(shadow.textContent).not.toContain('completed</em>');
    expect(shadow.textContent).not.toMatch(/All \d+ subagents completed/);

    // Header counts both dimensions from the one list.
    expect(shadow.textContent).toContain('1 active');
    expect(shadow.textContent).toContain('1 done');

    element.remove();
  });

  it('does not show success while a retained subagent status still lags', async () => {
    const element = document.createElement(
      'background-tasks-panel',
    ) as BackgroundTasksPanel;
    element.subagents = [
      {
        kind: 'subagent',
        executionId: 'subagent-1',
        childStreamId: 'child-1',
        agentName: 'reviewer',
        status: 'running',
        finishedAt: 1_000,
      },
    ];
    document.body.append(element);
    await element.updateComplete;

    const badge = element.shadowRoot?.querySelector('wa-badge.task-status');
    expect(badge?.textContent).toBe('running');
    expect(badge?.getAttribute('variant')).toBe('warning');

    element.remove();
  });
});
