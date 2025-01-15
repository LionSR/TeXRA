// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from './logUtils';
import { LogViewProvider } from './LogViewProvider';

const CHANNEL = 'MessageHandler';

export class LogViewMessageHandler {
  constructor(private readonly provider: LogViewProvider) {}

  async handleMessage(
    message: any,
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    logger.debug(CHANNEL, `Received message: ${message.command}`);

    switch (message.command) {
      case 'switchStream':
        this.provider.setActiveStream(message.stream);
        break;
      case 'clearStream':
        this.provider.clearStream(message.stream);
        break;
      case 'deleteStream':
        this.provider.deleteStream(message.stream);
        break;
      case 'deleteAll':
        this.provider.deleteAllStreams();
        break;
      case 'stopStream':
        vscode.commands.executeCommand('coauthor.stopAgent', message.stream);
        break;
      default:
        logger.warn(CHANNEL, `Unknown command: ${message.command}`);
    }
  }
}
