// Third-party imports
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { shouldUseConsolidatedChannel } from '@utils/loggerUtils';
import { AgentLogger } from '@logger/AgentLogger';

interface ColoredLogMessage {
  id: string;
  message: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  timestamp: number;
  groupId?: string;
  messageType?: 'default' | 'scratchpad' | 'thinking';
}

/**
 * Manages persisted stream tabs and their log messages.
 */
export class StreamTabs {
  private readonly logger = new AgentLogger('StreamTabs');
  private _streams: Map<string, ColoredLogMessage[]> = new Map();

  private _getWorkspaceKey(key: WorkspaceStateKey | string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  async load(): Promise<void> {
    const key = this._getWorkspaceKey(WorkspaceStateKey.STREAM_TABS);
    let saved = workspaceSM.get<{ [key: string]: ColoredLogMessage[] }>(key);

    if (!saved) {
      const oldKey = this._getWorkspaceKey('texra.logStreams');
      const oldSaved = workspaceSM.get<{ [key: string]: ColoredLogMessage[] }>(
        oldKey,
      );
      if (oldSaved) {
        saved = oldSaved;
        await workspaceSM.update(oldKey, undefined);
        this.logger.debug('Migrated log streams to stream tabs');
      }
    }

    if (saved) {
      this._streams = new Map(
        Object.entries(saved)
          .filter(([channel]) => !shouldUseConsolidatedChannel(channel))
          .map(([stream, messages]) => [
            stream,
            messages.map((msg) => {
              if (!msg.id) {
                msg.id = randomUUID();
              }
              if (msg.timestamp === undefined) {
                const attrMatch = msg.message.match(
                  /data-full-timestamp="([^"]+)"/,
                );
                const timeString =
                  attrMatch?.[1] || (msg.message.match(/\[(.*?)\]/)?.[1] ?? '');
                const timestamp = new Date(timeString).getTime();
                msg.timestamp = isNaN(timestamp) ? Date.now() : timestamp;
              }
              if (!msg.messageType) {
                msg.messageType = 'default';
              }
              return msg;
            }),
          ]),
      );
    } else {
      this._streams.clear();
    }
  }

  save(): void {
    const persistent = Array.from(this._streams.entries()).filter(
      ([channel]) => !shouldUseConsolidatedChannel(channel),
    );
    const obj = Object.fromEntries(persistent);
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.STREAM_TABS),
      obj,
    );
  }

  get(stream: string): ColoredLogMessage[] | undefined {
    return this._streams.get(stream);
  }

  set(stream: string, messages: ColoredLogMessage[]): void {
    this._streams.set(stream, messages);
  }

  delete(stream: string): void {
    this._streams.delete(stream);
  }

  clear(): void {
    this._streams.clear();
  }

  entries(): IterableIterator<[string, ColoredLogMessage[]]> {
    return this._streams.entries();
  }

  keys(): IterableIterator<string> {
    return this._streams.keys();
  }

  has(stream: string): boolean {
    return this._streams.has(stream);
  }
}
