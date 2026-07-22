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
});
