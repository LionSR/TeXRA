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

function sampleSkill() {
  return ActiveSkillSummarySchema.parse({
    name: 'proof-audit',
    description: 'Review proofs.',
    source: 'project',
  });
}

describe('active-skills-details', () => {
  useLitComponentTestDom(async () => {
    await import('@progressView/frontend/components/ActiveSkillsDetails');
  });

  it('hides empty catalogs and renders a collapsed wa-details panel', async () => {
    const element = createElement();
    document.body.append(element);
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector('wa-details')).toBeNull();

    element.skills = [sampleSkill()];
    await element.updateComplete;

    const details = element.shadowRoot?.querySelector('wa-details');
    expect(details).toBeInstanceOf(HTMLElement);
    expect(details?.hasAttribute('open')).toBe(false);
    expect(details?.getAttribute('summary')).toContain('Skills (1)');
  });

  it('closes an open panel when collapseKey changes', async () => {
    const element = createElement();
    element.skills = [sampleSkill()];
    element.collapseKey = 'stream-a';
    document.body.append(element);
    await element.updateComplete;

    const details = element.shadowRoot?.querySelector('wa-details');
    expect(details).toBeInstanceOf(HTMLElement);

    details?.dispatchEvent(new Event('wa-show'));
    await element.updateComplete;
    expect(details?.hasAttribute('open')).toBe(true);

    element.collapseKey = 'stream-b';
    await element.updateComplete;
    expect(details?.hasAttribute('open')).toBe(false);
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
