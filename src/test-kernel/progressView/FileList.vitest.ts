// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { FileList } from '@progressView/frontend/components/FileList';
import type { OutputFileInfo } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';

// Local file imports
import {
  dispatchKey,
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

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
    },
    diff: { added: 2, removed: 1 },
  };
}

describe('file-list keyboard activation', () => {
  useLitComponentTestDom(
    () => import('@progressView/frontend/components/FileList'),
  );

  it('opens file paths on Space without hijacking native action buttons', async () => {
    const element = await mountComponent<FileList>('file-list', {
      streamId: 'stream-a',
      filesByRound: { '1': [outputFile()] },
    });
    const actions: HostRequest[] = [];
    element.addEventListener('host-request', (event) => {
      actions.push(event.detail);
    });

    const filePath = element.shadowRoot?.querySelector('.file-path');
    expect(filePath).toBeInstanceOf(HTMLElement);
    expect(filePath?.hasAttribute('title')).toBe(false);
    expect(
      element.shadowRoot
        ?.querySelector(`wa-tooltip[for="${filePath?.id}"]`)
        ?.textContent?.trim(),
    ).toBe('paper_revised.tex');
    dispatchKey(filePath!, ' ');

    expect(actions).toEqual([
      { kind: 'openFile', path: '/workspace/paper_revised.tex', line: null },
    ]);

    const nativeButton = element.shadowRoot?.querySelector(
      'wa-button[data-command]',
    );
    expect(nativeButton).toBeInstanceOf(HTMLElement);
    dispatchKey(nativeButton!, ' ');

    expect(actions).toHaveLength(1);
  });
});
