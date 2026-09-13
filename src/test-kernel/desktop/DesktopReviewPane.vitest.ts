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

function reviewPayload(
  path: string,
  additions = 1,
  deletions = 1,
  previewId = `preview-${path}`,
) {
  return {
    command: 'desktop:showDiff' as const,
    session: 'paper-a',
    previewId,
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

/** The title of the review currently on screen. */
function selectedTitle(controller: ReviewPane): string | null | undefined {
  return controller.element.querySelector('.desktop-review-summary strong')
    ?.textContent;
}

/** Click the tree entry for `path`, as the user picking a file to read. */
function selectFile(controller: ReviewPane, path: string): void {
  const button = controller.element.querySelector<HTMLElement>(
    `wa-button.desktop-review-file[title="${path}"]`,
  );
  if (!button) throw new Error(`no review tree entry for ${path}`);
  // Dispatched rather than `click()`: the WebAwesome button forwards that to
  // an inner native button its shadow root has no room for here.
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

  it('closes only the reviews the named preview opened', async () => {
    const controller = await newReviewPane();
    controller.open(reviewPayload('src/main.ts', 1, 1, 'request-a'));
    controller.open(reviewPayload('src/other.ts', 1, 1, 'request-b'));
    // The user goes back to the older request's diff in the tree.
    selectFile(controller, 'src/main.ts');
    expect(selectedTitle(controller)).toContain('src/main.ts');

    // The newer request settles: its review goes, the one being read stays
    // on screen, and the pane is not empty, so the Review tab stays too.
    expect(controller.close('request-b')).toBe(false);
    expect(fileButtons(controller)).toHaveLength(1);
    expect(selectedTitle(controller)).toContain('src/main.ts');

    expect(controller.close('request-a')).toBe(true);
    expect(controller.element.textContent).toContain('No changes to review');

    // Closing the review on screen falls back to one the pane still holds.
    controller.open(reviewPayload('src/main.ts', 1, 1, 'request-c'));
    controller.open(reviewPayload('src/other.ts', 1, 1, 'request-d'));
    expect(controller.close('request-d')).toBe(false);
    expect(selectedTitle(controller)).toContain('src/main.ts');
  });
});
