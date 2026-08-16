// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - webview base class
import { BaseViewMessageHandler } from '@common/webview/BaseViewMessageHandler';

// Type imports
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  showErrorMessage: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: { showErrorMessage: mocks.showErrorMessage },
}));

vi.mock('@logger/logUtils', () => ({
  createLog: vi.fn(() => ({
    debug: vi.fn(),
    error: mocks.logError,
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

class TestMessageHandler extends BaseViewMessageHandler {
  public async handleMessage(): Promise<void> {
    await this.dispatchInbound(
      { command: 'test' },
      { webview: {} } as vscode.WebviewView,
      (_message, _handlers, onError) => {
        onError(new Error('handler failure'));
        return true;
      },
      {},
    );
  }
}

describe('BaseViewMessageHandler', () => {
  it('surfaces unexpected inbound-message failures to the user', async () => {
    const handler = new TestMessageHandler('TestView');

    await handler.handleMessage();

    expect(mocks.logError).toHaveBeenCalledWith(
      'Error handling message',
      expect.objectContaining({ data: expect.any(Error) }),
    );
    expect(mocks.showErrorMessage).toHaveBeenCalledWith(
      'TeXRA could not handle a TestView message. See the TeXRA output for details.',
    );
  });
});
