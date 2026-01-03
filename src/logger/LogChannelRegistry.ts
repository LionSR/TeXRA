// Third-party imports
import * as winston from 'winston';
import * as vscode from 'vscode';

// Local imports - config
import { getConfig } from '@utils/config';

// Local imports - logger
import { ProgressViewSink } from './sinks/ProgressViewSink';
import { VSCodeTransport } from './transports/VSCodeTransport';

// Type imports
import type { LogEventSink } from './types/LogEventSink';

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

  getLogger(channel: string, options: ChannelOptions): winston.Logger {
    return this.getOrCreate(channel, options).logger;
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

    const sink: LogEventSink | undefined = options.isAgent
      ? new ProgressViewSink()
      : undefined;

    const transport = new VSCodeTransport({
      channel: outputChannel,
      streamName: channel,
      sink,
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

  /**
   * Dispose all output channels and clear the registry.
   * Should be called during extension deactivation.
   */
  dispose(): void {
    for (const entry of this.channels.values()) {
      if (entry.options.isAgent) {
        // Agent channels own their output channel - dispose both
        entry.transport.close();
      } else {
        // Shared channels use the main output channel - only clear state
        entry.transport.clearState();
      }
    }
    this.channels.clear();

    // Dispose the main output channel (used by non-agent transports)
    this.mainOutputChannel?.dispose();
    this.mainOutputChannel = null;
  }
}

export const registry = new LogChannelRegistry();
