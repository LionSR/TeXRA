import { describe, expect, it } from 'vitest';

import { DESKTOP_THEME_KIND } from '@shared/schemas/commonViewMessages';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

interface ReviewPaneController {
  readonly element: HTMLElement;
  clear(): void;
  open(payload: {
    command: 'desktop:showDiff';
    title: string;
    displayPath?: string;
    originalText: string;
    proposedText: string;
    additions: number;
    deletions: number;
    language: string;
  }): void;
  setTheme(theme: string): void;
}

interface ReviewPaneModule {
  createReviewPane(): ReviewPaneController;
}

async function loadReviewPane(): Promise<ReviewPaneModule> {
  return import('@desktop/renderer/reviewPane') as Promise<ReviewPaneModule>;
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

describe('desktop review pane', () => {
  useLitComponentTestDom(loadReviewPane);

  it('renders cumulative counts and a changed-file tree', async () => {
    const { createReviewPane } = await loadReviewPane();
    const controller = createReviewPane();

    controller.open(reviewPayload('packages/desktop/src/main.ts', 4, 2));
    controller.open(reviewPayload('packages/desktop/src/styles.css', 3, 1));

    expect(
      controller.element.querySelector('.desktop-review-counts')?.textContent,
    ).toContain('+7');
    expect(
      controller.element.querySelector('.desktop-review-counts')?.textContent,
    ).toContain('-3');
    expect(
      controller.element.querySelectorAll('wa-button.desktop-review-file'),
    ).toHaveLength(2);
    expect(
      controller.element.querySelectorAll('wa-details.desktop-review-directory')
        .length,
    ).toBeGreaterThan(0);
  });

  it('updates an existing file instead of duplicating it', async () => {
    const { createReviewPane } = await loadReviewPane();
    const controller = createReviewPane();

    controller.open(reviewPayload('src/main.ts'));
    controller.open(reviewPayload('src/main.ts', 8, 5));

    expect(
      controller.element.querySelectorAll('wa-button.desktop-review-file'),
    ).toHaveLength(1);
    expect(
      controller.element.querySelector('.desktop-review-counts')?.textContent,
    ).toContain('+8');
  });

  it('clears retained reviews and propagates theme changes', async () => {
    const { createReviewPane } = await loadReviewPane();
    const controller = createReviewPane();
    controller.open(reviewPayload('src/main.ts'));

    controller.setTheme(DESKTOP_THEME_KIND.LIGHT);
    const diff = controller.element.querySelector('texra-diff-view') as
      (HTMLElement & { hostTheme: string }) | null;
    expect(diff?.hostTheme).toBe(DESKTOP_THEME_KIND.LIGHT);

    controller.clear();
    expect(controller.element.textContent).toContain('No changes to review');
  });
});
