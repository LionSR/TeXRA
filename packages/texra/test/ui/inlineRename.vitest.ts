// Third-party imports
import { assert, describe, expect, it } from 'vitest';

// Local imports
import { useLitComponentTestDom } from '@test/progressView/litComponentTestUtils';

// Failure mode: the Enter an input method takes to finish composing a
// character (Japanese, Chinese, Korean) saved and closed the rename field
// with the half-typed name.
describe('inlineRenameField', () => {
  useLitComponentTestDom();

  it('keeps the field open on the Enter that ends a composition', async () => {
    // lit reads `document` when it loads, so it loads over the test DOM.
    const { render } = await import('lit');
    const { inlineRenameField } = await import('@ui/wa/inlineRename');
    const renamed: string[] = [];
    let closed = false;
    render(
      inlineRenameField({
        value: 'Draft',
        label: 'Rename task',
        className: 'row',
        onRename: (value) => renamed.push(value),
        onClose: () => {
          closed = true;
        },
      }),
      document.body,
    );
    const input = document.body.querySelector('input');
    assert(input instanceof HTMLInputElement);
    input.value = 'ドラフト';
    const enter = (isComposing: boolean) =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing }),
      );

    enter(true);
    expect(closed).toBe(false);
    expect(renamed).toStrictEqual([]);

    enter(false);
    expect(closed).toBe(true);
    expect(renamed).toStrictEqual(['ドラフト']);
  });
});
