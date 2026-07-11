// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

useLitComponentTestDom(() => import('@shared/wa/emptyState'));

type RenderEmptyState = typeof import('@shared/wa/emptyState').renderEmptyState;
type EmptyStateOptions = Parameters<RenderEmptyState>[0];

/**
 * The empty-states consolidation moved GoalTab, MemoryList, HistoryList
 * (x2), TaskGroupList, and StreamTabs off hand-rolled `.empty-state` /
 * `.log-placeholder` markup onto this shared helper. These tests pin the
 * contract those six call sites now depend on.
 *
 * `lit` and `lit-html` must NOT be imported statically at module top level
 * here: lit-html caches its DOM-creation helpers off `global.document` the
 * first time it's evaluated, and useLitComponentTestDom only patches
 * `document` onto globalThis inside its `beforeAll`. A static top-level
 * import would freeze lit-html onto a document-less stub before that patch
 * runs (surfacing as `d.createComment is not a function`), so both `lit`
 * and the module under test are imported dynamically, inside test bodies,
 * after the DOM patch has already happened.
 */
async function renderEmptyStateInto(
  options: EmptyStateOptions,
): Promise<HTMLElement> {
  const { render } = await import('lit');
  const { renderEmptyState } = await import('@shared/wa/emptyState');
  const container = document.createElement('div');
  document.body.append(container);
  render(renderEmptyState(options), container);
  return container;
}

describe('renderEmptyState shared helper', () => {
  it('renders an icon, heading, and body with the requested class hooks', async () => {
    const container = await renderEmptyStateInto({
      icon: 'database',
      title: 'No saved memories yet.',
      body: 'Memories are created automatically.',
      className: 'empty-state',
    });

    const section = container.querySelector('section.empty-state');
    expect(section).toBeTruthy();

    const icon = section?.querySelector('.empty-state-icon');
    expect(icon?.tagName.toLowerCase()).toBe('wa-icon');

    // Defaults to h2 when no headingTag is supplied.
    const title = section?.querySelector('h2.empty-state-title');
    expect(title?.textContent).toBe('No saved memories yet.');

    const body = section?.querySelector('.empty-state-body');
    expect(body?.textContent).toBe('Memories are created automatically.');
  });

  it('omits the body element entirely when no body is supplied', async () => {
    const container = await renderEmptyStateInto({
      icon: 'history',
      title: 'No history items match your search.',
      className: 'empty-state',
    });

    expect(container.querySelector('.empty-state-body')).toBeNull();
  });

  it('promotes the heading tag via headingTag (h3 for nested tab sections)', async () => {
    const container = await renderEmptyStateInto({
      icon: 'compass',
      title: 'No Goals yet.',
      headingTag: 'h3',
      className: 'empty-state',
    });

    expect(container.querySelector('h3.empty-state-title')?.textContent).toBe(
      'No Goals yet.',
    );
    expect(container.querySelector('h2.empty-state-title')).toBeNull();
  });

  it('renders one wa-button per action, each wired to its own onClick', async () => {
    const runSetup = vi.fn();
    const openWalkthrough = vi.fn();
    const container = await renderEmptyStateInto({
      icon: 'terminal',
      title: 'No runs yet',
      className: 'log-placeholder',
      actions: [
        { label: 'Run setup', icon: 'rocket', onClick: runSetup },
        { label: 'Walkthrough', icon: 'book', onClick: openWalkthrough },
      ],
    });

    const buttons = [
      ...container.querySelectorAll('.empty-state-actions wa-button'),
    ];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent?.trim()).toContain('Run setup');
    expect(buttons[1]?.textContent?.trim()).toContain('Walkthrough');

    buttons[1]?.dispatchEvent(new Event('click', { bubbles: true }));
    expect(openWalkthrough).toHaveBeenCalledTimes(1);
    expect(runSetup).not.toHaveBeenCalled();
  });

  it('forwards an action size to the underlying wa-button, defaulting to the component default', async () => {
    const container = await renderEmptyStateInto({
      icon: 'terminal',
      title: 'No runs yet',
      className: 'log-placeholder',
      actions: [
        { label: 'Run setup', icon: 'rocket', size: 'small', onClick: vi.fn() },
        { label: 'Walkthrough', icon: 'book', onClick: vi.fn() },
      ],
    });

    const buttons = [
      ...container.querySelectorAll('.empty-state-actions wa-button'),
    ];
    expect(buttons[0]?.getAttribute('size')).toBe('small');
    // No `size` supplied: falls through to <wa-button>'s own default
    // (medium), matching ProgressApp's unsized action buttons.
    expect(buttons[1]?.getAttribute('size')).not.toBe('small');
  });

  it('renders no actions container when actions is omitted', async () => {
    const container = await renderEmptyStateInto({
      icon: 'terminal',
      title: 'No streams yet',
      body: 'Run a TeXRA command to get started.',
      className: 'log-placeholder',
    });

    expect(container.querySelector('.empty-state-actions')).toBeNull();
  });
});
