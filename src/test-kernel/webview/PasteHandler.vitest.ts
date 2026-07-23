import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  asyncReadStarted: false,
  clipboardImageFiles: vi.fn(),
  generatePastedImageName: vi.fn(),
  getExtensionFromMimeType: vi.fn(),
  insertTextAtCursor: vi.fn(),
  postMessage: vi.fn(),
  readFileAsBase64: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

vi.mock('@utils/files/pastedImageName', () => ({
  generatePastedImageName: mocks.generatePastedImageName,
}));

vi.mock('@shared/utils/clipboardImages', () => ({
  clipboardImageFiles: mocks.clipboardImageFiles,
  getExtensionFromMimeType: mocks.getExtensionFromMimeType,
  readFileAsBase64: mocks.readFileAsBase64,
}));

vi.mock('@shared/utils/textarea', () => ({
  insertTextAtCursor: mocks.insertTextAtCursor,
}));

describe('handleImagePaste', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.asyncReadStarted = false;
    mocks.clipboardImageFiles.mockReturnValue([
      { file: {} as File, type: 'image/png' },
    ]);
    mocks.generatePastedImageName.mockReturnValue('pasted_test.png');
    mocks.getExtensionFromMimeType.mockReturnValue('png');
    mocks.readFileAsBase64.mockImplementation(async () => {
      mocks.asyncReadStarted = true;
      return 'encoded-image';
    });
  });

  it('preserves mixed text and image paste text before async clipboard protection', async () => {
    const { handleImagePaste } = await import('@webview/frontend/pasteHandler');
    const target = {} as HTMLElement;
    const getData = vi.fn((type: string) =>
      type === 'text/plain' && !mocks.asyncReadStarted ? 'describe this' : '',
    );
    const event = {
      clipboardData: { getData },
      preventDefault: vi.fn(),
    } as unknown as ClipboardEvent;

    await expect(handleImagePaste(event, target)).resolves.toBe(true);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(getData).toHaveBeenCalledWith('text/plain');
    expect(getData).toHaveBeenCalledTimes(1);
    expect(mocks.insertTextAtCursor).toHaveBeenCalledWith(
      target,
      'describe this [pasted_test.png]',
    );
  });
});
