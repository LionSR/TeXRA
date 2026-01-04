// Third-party imports
import * as winston from 'winston';
import * as vscode from 'vscode';

// Local imports - config
import { getConfig } from '@utils/config';

// Local imports - logger
import { VSCodeTransport } from './transports/VSCodeTransport';

interface ChannelEntry {
  logger: winston.Logger;
  transport: VSCodeTransport;
  options: ChannelOptions;
}

interface ChannelOptions {
  isAgent: boolean;
}

export class LogChannelRegistry {
  private mainOutputChannel: vscode.OutputChannel | null = null;
  private readonly channels = new Map<string, ChannelEntry>();

  ensure(channel: string, options: ChannelOptions): ChannelEntry {
    return this.getOrCreate(channel, options);
  }

  getTransport(
    channel: string,
    options?: ChannelOptions,
  ): VSCodeTransport | undefined {
    const key = this.getKey(channel, options?.isAgent ?? false);
    return this.channels.get(key)?.transport;
  }

  private getOrCreate(channel: string, options: ChannelOptions): ChannelEntry {
    const key = this.getKey(channel, options.isAgent);
    const existing = this.channels.get(key);
    if (existing) {
      return existing;
    }

    const outputChannel = options.isAgent
      ? vscode.window.createOutputChannel(`TeXRA ${channel}`)
      : this.getMainOutputChannel();

    const transport = new VSCodeTransport({
      channel: outputChannel,
      streamName: channel,
      isAgentChannel: options.isAgent,
      includeStructuredData: () =>
        getConfig<boolean>('texra.logger.debugMode', false),
    });

    const logger = winston.createLogger({
      levels: {
        error: 0,
        warn: 1,
        info: 2,
        debug: 3,
      },
      level: 'debug',
      format: winston.format.combine(
        winston.format.timestamp({
          format: 'YYYY-MM-DD HH:mm:ss.SSS',
        }),
      ),
      transports: [transport],
    });

    const entry: ChannelEntry = { logger, transport, options };
    this.channels.set(key, entry);
    return entry;
  }

  private getMainOutputChannel(): vscode.OutputChannel {
    if (!this.mainOutputChannel) {
      this.mainOutputChannel = vscode.window.createOutputChannel('TeXRA');
    }
    return this.mainOutputChannel;
  }

  private getKey(channel: string, isAgent: boolean): string {
    return `${channel}::${isAgent ? 'agent' : 'shared'}`;
  }
}

export const registry = new LogChannelRegistry();
