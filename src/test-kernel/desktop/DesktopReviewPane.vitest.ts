import { describe, expect, it } from 'vitest';

import { DESKTOP_THEME_KIND } from '@shared/schemas';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

type ReviewPane = ReturnType<
  (typeof import('@desktop/renderer/reviewPane'))['createReviewPane']
>;

async function newReviewPane(): Promise<ReviewPane> {
  const { createReviewPane } = await import('@desktop/renderer/reviewPane');
  return createReviewPane();
}

function reviewPayload(path: string, additions = 1, deletions = 1) {
  return {
    command: 'desktop:showDiff' as const,
    title: `Tool edit: ${path}`,
    displayPath: path,
    originalText: 'old\n',
    proposedText: 'new\n',
    additions,
    deletions,
    language: 'typescript',
  };
}

function fileButtons(controller: ReviewPane): NodeListOf<Element> {
  return controller.element.querySelectorAll('wa-button.desktop-review-file');
}

function countsText(controller: ReviewPane): string | null | undefined {
  return controller.element.querySelector('.desktop-review-counts')
    ?.textContent;
}

describe('desktop review pane', () => {
  useLitComponentTestDom(() => import('@desktop/renderer/reviewPane'));

  it('renders cumulative counts and a changed-file tree', async () => {
    const controller = await newReviewPane();

    controller.open(reviewPayload('packages/desktop/src/main.ts', 4, 2));
    controller.open(reviewPayload('packages/desktop/src/styles.css', 3, 1));

    expect(countsText(controller)).toContain('+7');
    expect(countsText(controller)).toContain('-3');
    expect(fileButtons(controller)).toHaveLength(2);
    expect(
      controller.element.querySelectorAll('wa-details.desktop-review-directory')
        .length,
    ).toBeGreaterThan(0);
  });

  it('updates an existing file instead of duplicating it', async () => {
    const controller = await newReviewPane();

    controller.open(reviewPayload('src/main.ts'));
    controller.open(reviewPayload('src/main.ts', 8, 5));

    expect(fileButtons(controller)).toHaveLength(1);
    expect(countsText(controller)).toContain('+8');
  });

  it('clears retained reviews and propagates theme changes', async () => {
    const controller = await newReviewPane();
    controller.open(reviewPayload('src/main.ts'));

    controller.setTheme(DESKTOP_THEME_KIND.LIGHT);
    const diff = controller.element.querySelector('texra-diff-view') as
      (HTMLElement & { hostTheme: string }) | null;
    expect(diff?.hostTheme).toBe(DESKTOP_THEME_KIND.LIGHT);

    controller.clear();
    expect(controller.element.textContent).toContain('No changes to review');
  });
});
