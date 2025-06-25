// Third-party imports
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

// Local imports
import { WorkspaceStateKey, workspaceSM } from '@utils/stateManager';
import { shouldUseConsolidatedChannel } from '@utils/loggerUtils';
import { AgentLogger } from '@logger/AgentLogger';

// Types

interface ColoredLogMessage {
  id: string;
  message: string;
  level: 'error' | 'warn' | 'info' | 'debug';
  timestamp: number;
  groupId?: string;
  messageType?: 'default' | 'scratchpad' | 'thinking';
}

/**
 * Manages log streams and the active stream.
 */
export class StreamsManager {
  public readonly map: Map<string, ColoredLogMessage[]> = new Map();
  private _active = '';
  private readonly logger = new AgentLogger('StreamsManager');

  private _getWorkspaceKey(key: WorkspaceStateKey | string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? `${key}.${workspaceFolder.uri.fsPath}` : key;
  }

  get active(): string {
    return this._active;
  }

  set active(stream: string) {
    this._active = stream;
  }

  async load(): Promise<void> {
    const saved = workspaceSM.get<{
      [key: string]: ColoredLogMessage[];
    }>(this._getWorkspaceKey(WorkspaceStateKey.LOG_STREAMS));

    if (saved) {
      this.map.clear();
      for (const [stream, messages] of Object.entries(saved)) {
        if (shouldUseConsolidatedChannel(stream)) {
          continue;
        }
        const processed = messages.map((msg) => {
          if (!msg.id) {
            msg.id = randomUUID();
          }
          if (msg.timestamp === undefined) {
            const attrMatch = msg.message.match(
              /data-full-timestamp="([^"]+)"/,
            );
            const timeString =
              attrMatch?.[1] || (msg.message.match(/\[(.*?)\]/)?.[1] ?? '');
            const ts = new Date(timeString).getTime();
            msg.timestamp = isNaN(ts) ? Date.now() : ts;
          }
          if (!msg.messageType) {
            msg.messageType = 'default';
          }
          return msg;
        });
        this.map.set(stream, processed);
      }
    } else {
      this.map.clear();
    }

    const savedActive = workspaceSM.get<string>(
      WorkspaceStateKey.ACTIVE_LOG_STREAM,
    );
    if (savedActive && this.map.has(savedActive)) {
      this._active = savedActive;
    } else {
      this._active = Array.from(this.map.keys())[0] ?? '';
    }
  }

  save(): void {
    const persistent = Array.from(this.map.entries()).filter(
      ([channel]) => !shouldUseConsolidatedChannel(channel),
    );
    workspaceSM.update(
      this._getWorkspaceKey(WorkspaceStateKey.LOG_STREAMS),
      Object.fromEntries(persistent),
    );
    workspaceSM.update(WorkspaceStateKey.ACTIVE_LOG_STREAM, this._active);
  }

  clear(stream: string): void {
    this.map.delete(stream);
    if (this._active === stream) {
      this._active = '';
    }
  }

  clearAll(): void {
    this.map.clear();
    this._active = '';
  }
}
