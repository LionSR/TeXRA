import * as vscode from 'vscode';

const outputChannels: Map<string, vscode.OutputChannel> = new Map();

export function initializeLogging(channelName: string): void {
  if (!outputChannels.has(channelName)) {
    outputChannels.set(
      channelName,
      vscode.window.createOutputChannel(channelName),
    );
  }
}

export function getTimestamp(): string {
  return new Date().toISOString().split('.')[0].replace('T', ' ');
}

export function log(
  channelName: string,
  category: string,
  message: string,
  isError: boolean = false,
): void {
  const outputChannel = outputChannels.get(channelName);
  if (!outputChannel) {
    throw new Error(
      `Output channel "${channelName}" not initialized. Call initializeLogging first.`,
    );
  }
  const timestamp = getTimestamp();
  const prefix = isError ? '🔴' : '🟢';
  outputChannel.appendLine(`${prefix} [${timestamp}] [${category}] ${message}`);
}

export function getOutputChannel(channelName: string): vscode.OutputChannel {
  const outputChannel = outputChannels.get(channelName);
  if (!outputChannel) {
    throw new Error(
      `Output channel "${channelName}" not initialized. Call initializeLogging first.`,
    );
  }
  return outputChannel;
}
