// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { FileList } from '@progressView/frontend/components/FileList';
import type { ProgressFileActionDetail } from '@progressView/frontend/events';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { OutputFileInfo } from '@shared/schemas';

// Local file imports
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

function outputFile(): OutputFileInfo {
  return {
    source: 'paper_revised.tex',
    location: {
      kind: 'workspace',
      absolutePath: '/workspace/paper_revised.tex',
      relativePath: 'paper_revised.tex',
    },
    round: 1,
    lineage: {
      original: {
        kind: 'workspace',
        absolutePath: '/workspace/paper.tex',
        relativePath: 'paper.tex',
      },
      diffBase: null,
      diffFile: null,
    },
    diff: { added: 2, removed: 1 },
  };
}

async function mountFileList(): Promise<FileList> {
  const element = document.createElement('file-list') as FileList;
  element.filesByRound = { '1': [outputFile()] };
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function dispatchSpace(target: Element): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

describe('file-list keyboard activation', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/FileList'),
  );

  it('opens file paths on Space without hijacking native action buttons', async () => {
    const element = await mountFileList();
    const actions: ProgressFileActionDetail[] = [];
    element.addEventListener('file-action', (event) => {
      actions.push((event as CustomEvent<ProgressFileActionDetail>).detail);
    });

    const filePath = element.shadowRoot?.querySelector('.file-path');
    expect(filePath).toBeInstanceOf(HTMLElement);
    expect(filePath?.hasAttribute('title')).toBe(false);
    expect(
      element.shadowRoot
        ?.querySelector(`wa-tooltip[for="${filePath?.id}"]`)
        ?.textContent?.trim(),
    ).toBe('paper_revised.tex');
    dispatchSpace(filePath!);

    expect(actions).toEqual([
      {
        command: PROGRESS_VIEW_COMMANDS.OPEN_FILE,
        file: '/workspace/paper_revised.tex',
        base: undefined,
        prev: undefined,
      },
    ]);

    const nativeButton = element.shadowRoot?.querySelector(
      'wa-button[data-command]',
    );
    expect(nativeButton).toBeInstanceOf(HTMLElement);
    dispatchSpace(nativeButton!);

    expect(actions).toHaveLength(1);
  });
});
