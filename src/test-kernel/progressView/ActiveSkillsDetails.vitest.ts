import { describe, expect, it } from 'vitest';

import type { ActiveSkillsDetails as ActiveSkillsDetailsElement } from '@progressView/frontend/components/ActiveSkillsDetails';
import { ActiveSkillSummarySchema } from '@shared/schemas';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

interface StyledConstructor extends CustomElementConstructor {
  readonly elementStyles: readonly (
    CSSStyleSheet | { readonly cssText: string }
  )[];
}

function createElement(): ActiveSkillsDetailsElement {
  return document.createElement(
    'active-skills-details',
  ) as ActiveSkillsDetailsElement;
}

describe('active-skills-details', () => {
  useLitComponentTestDom(async () => {
    await import('@progressView/frontend/components/ActiveSkillsDetails');
  });

  it('hides empty catalogs and renders a native collapsed details block', async () => {
    const element = createElement();
    document.body.append(element);
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector('details')).toBeNull();

    element.skills = [
      ActiveSkillSummarySchema.parse({
        name: 'proof-audit',
        description: 'Review proofs.',
        source: 'project',
      }),
    ];
    await element.updateComplete;

    const details = element.shadowRoot?.querySelector('details');
    expect(details).toBeInstanceOf(HTMLElement);
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.querySelector('summary')?.textContent).toContain(
      'Skills (1)',
    );
  });

  it('wraps a maximum-length unbroken description within narrow containers', async () => {
    const description = 'x'.repeat(300);
    const skill = ActiveSkillSummarySchema.parse({
      name: 'long-description',
      description,
      source: 'custom',
    });
    const element = createElement();
    element.skills = [skill];
    document.body.append(element);
    await element.updateComplete;

    const item = element.shadowRoot?.querySelector('li');
    expect(skill.description).toHaveLength(180);
    expect(item?.textContent).toContain(skill.description);

    const constructor = element.constructor as StyledConstructor;
    const styleText = constructor.elementStyles
      .map((style) => {
        if ('cssText' in style) return style.cssText;
        return [...style.cssRules].map((rule) => rule.cssText).join('\n');
      })
      .join('\n');
    expect(styleText).toMatch(/min-width:\s*0/);
    expect(styleText).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
