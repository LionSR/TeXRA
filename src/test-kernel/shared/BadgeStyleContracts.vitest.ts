import { describe, expect, it } from 'vitest';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

const BADGE_PROPERTIES = [
  'gap',
  'padding',
  'font-size',
  'font-weight',
] as const;

interface StyledElementConstructor extends CustomElementConstructor {
  readonly elementStyles: readonly (
    CSSStyleSheet | { readonly cssText: string }
  )[];
}

interface BadgeStyleContract {
  readonly tagName: string;
  readonly selector: string;
  readonly declarations: Record<(typeof BADGE_PROPERTIES)[number], string>;
}

const BADGE_STYLE_CONTRACTS: readonly BadgeStyleContract[] = [
  {
    tagName: 'stream-header',
    selector: '.goal-chip::part(base)',
    declarations: {
      gap: 'var(--wa-space-3xs)',
      padding: '0 var(--wa-space-2xs)',
      'font-size': '',
      'font-weight': 'var(--font-weight-medium)',
    },
  },
  {
    tagName: 'worktree-chip',
    selector: '.pill::part(base)',
    declarations: {
      gap: 'var(--wa-space-3xs)',
      padding: '0 var(--wa-space-2xs)',
      'font-size': '',
      'font-weight': '',
    },
  },
  {
    tagName: 'background-tasks-panel',
    selector: 'wa-badge.task-status::part(base)',
    declarations: {
      gap: '',
      padding: 'var(--wa-space-3xs) var(--wa-space-2xs)',
      'font-size': 'var(--font-size-xs)',
      'font-weight': 'var(--font-weight-medium)',
    },
  },
  {
    tagName: 'goal-tab',
    selector: '.status-chip::part(base)',
    declarations: {
      gap: '',
      padding: 'var(--wa-space-3xs) var(--wa-space-2xs)',
      'font-size': '',
      'font-weight': 'var(--wa-font-weight-semibold)',
    },
  },
  {
    tagName: 'tool-card',
    selector: 'wa-badge.tool-id-tag::part(base)',
    declarations: {
      gap: '',
      padding: '',
      'font-size': 'var(--font-size-xs)',
      'font-weight': '',
    },
  },
];

function componentStyleText(tagName: string): string {
  const element = document.createElement(tagName);
  const constructor = element.constructor as StyledElementConstructor;

  return constructor.elementStyles
    .map((style) => {
      if ('cssText' in style) return style.cssText;
      return [...style.cssRules].map((rule) => rule.cssText).join('\n');
    })
    .join('\n');
}

function findRule(styleText: string, selector: string): CSSStyleRule {
  const styleElement = document.createElement('style');
  styleElement.textContent = styleText;
  document.head.append(styleElement);

  const rule = [...(styleElement.sheet?.cssRules ?? [])].find(
    (candidate) => (candidate as CSSStyleRule).selectorText === selector,
  ) as CSSStyleRule | undefined;
  styleElement.remove();

  if (!rule) {
    throw new Error(`Missing badge style rule: ${selector}`);
  }
  return rule;
}

describe('badge style contracts', () => {
  useLitComponentTestDom(() =>
    Promise.all([
      import('@progressView/frontend/components/StreamHeader'),
      import('@progressView/frontend/components/WorktreeChip'),
      import('@progressView/frontend/components/BackgroundTasksPanel'),
      import('@settingsView/frontend/tabs/GoalTab'),
      import('@settingsView/frontend/components/tools/ToolCard'),
    ]),
  );

  it.each(BADGE_STYLE_CONTRACTS)(
    'preserves $tagName badge sizing, weight, and selector',
    ({ tagName, selector, declarations }) => {
      const styleText = componentStyleText(tagName);
      const rule = findRule(styleText, selector);
      const actual = Object.fromEntries(
        BADGE_PROPERTIES.map((property) => [
          property,
          rule.style.getPropertyValue(property).trim(),
        ]),
      );

      expect(actual).toEqual(declarations);
      expect(styleText).not.toContain('.badge-compact');
    },
  );
});
