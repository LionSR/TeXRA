// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from './logUtils';
import { LogViewProvider } from './LogViewProvider';

const CHANNEL = 'MessageHandler';

export class LogViewMessageHandler {
  constructor(private readonly provider: LogViewProvider) {}

  async handleMessage(message: any, webviewView: vscode.WebviewView) {
    logger.debug(CHANNEL, `Received message: ${message.command}`);

    switch (message.command) {
      case 'switchStream':
        this.handleSwitchStream(message.stream);
        break;
      case 'clearStream':
        this.handleClearStream(message.stream);
        break;
      case 'clearAll':
        this.handleClearAll();
        break;
      case 'deleteStream':
        this.handleDeleteStream(message.stream);
        break;
      default:
        logger.warn(CHANNEL, `Unknown command: ${message.command}`);
    }
  }

  private handleSwitchStream(stream: string) {
    // Get the stream and update the content
    const streams = this.provider.getLogStreams();
    if (streams.has(stream)) {
      this.provider.updateLogContent(stream);
    }
  }

  private handleClearStream(stream: string) {
    this.provider.clearStream(stream);
  }

  private handleClearAll() {
    this.provider.clearAllStreams();
  }

  private handleDeleteStream(stream: string) {
    this.provider.deleteStream(stream);
  }
}
