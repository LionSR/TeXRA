import { afterEach, describe, expect, it, vi } from 'vitest';

import { DESKTOP_WORKSPACE_COMMANDS } from '@desktop/shared/desktopWorkspaceMessages';

const mocks = vi.hoisted(() => ({ postMessage: vi.fn() }));

vi.mock('@shared/hostBridge', () => ({ postMessage: mocks.postMessage }));

import {
  disposePendingFileRequests,
  requestFileRead,
  requestFiles,
} from '@desktop/renderer/fileRequests';

describe('desktop file requests', () => {
  afterEach(() => {
    disposePendingFileRequests();
    mocks.postMessage.mockReset();
  });

  it('rejects every pending request when its renderer is disposed', async () => {
    const read = requestFileRead('main.tex');
    const list = requestFiles('.');

    disposePendingFileRequests();

    await expect(read).rejects.toThrow('desktop renderer was disposed');
    await expect(list).rejects.toThrow('desktop renderer was disposed');
    expect(mocks.postMessage).toHaveBeenCalledWith(
      DESKTOP_WORKSPACE_COMMANDS.READ_FILE,
      expect.objectContaining({ path: 'main.tex' }),
    );
  });
});
