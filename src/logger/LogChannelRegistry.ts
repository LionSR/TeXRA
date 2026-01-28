import * as winston from 'winston';
import * as vscode from 'vscode';

import { getConfig } from '@utils/config';

import { VSCodeTransport } from './transports/VSCodeTransport';

interface ChannelEntry {
  logger: winston.Logger;
  transport: VSCodeTransport;
  isAgent: boolean;
}

export class LogChannelRegistry {
  private mainOutputChannel: vscode.OutputChannel | null = null;
  private readonly channels = new Map<string, ChannelEntry>();

  getTransport(channel: string, isAgent = false): VSCodeTransport | undefined {
    return this.channels.get(this.getKey(channel, isAgent))?.transport;
  }

  ensure(channel: string, options: { isAgent: boolean }): ChannelEntry {
    const key = this.getKey(channel, options.isAgent);
    const existing = this.channels.get(key);
    if (existing) return existing;

    const outputChannel = options.isAgent
      ? vscode.window.createOutputChannel(`TeXRA ${channel}`)
      : (this.mainOutputChannel ??= vscode.window.createOutputChannel('TeXRA'));

    const transport = new VSCodeTransport({
      channel: outputChannel,
      streamId: channel,
      isAgentChannel: options.isAgent,
      includeStructuredData: () =>
        getConfig<boolean>('texra.logger.debugMode', false),
    });

    const entry: ChannelEntry = {
      logger: winston.createLogger({
        levels: { error: 0, warn: 1, info: 2, debug: 3 },
        level: 'debug',
        format: winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        transports: [transport],
      }),
      transport,
      isAgent: options.isAgent,
    };
    this.channels.set(key, entry);
    return entry;
  }

  private getKey(channel: string, isAgent: boolean): string {
    return isAgent ? `${channel}::agent` : `${channel}::shared`;
  }
}

export const registry = new LogChannelRegistry();
