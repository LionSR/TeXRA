// Third-party imports
import { execa, type ResultPromise } from 'execa';
import * as path from 'path';
import * as fs from 'fs';

// Local imports
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { extendEnvPath } from '@utils/system/platformPaths';

const CHANNEL = 'LeanLspClient';
logger.initialize(CHANNEL);

// ============================================================================
// Types
// ============================================================================

/** LSP Position (0-indexed line and character) */
export interface LspPosition {
  line: number;
  character: number;
}

/** LSP Range */
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** LSP Diagnostic Severity */
export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

/** LSP Diagnostic */
export interface LspDiagnostic {
  range: LspRange;
  severity?: DiagnosticSeverity;
  code?: number | string;
  source?: string;
  message: string;
}

/** Lean 4 Goal State from plainGoal request */
export interface LeanGoalState {
  goals: string[];
  rendered?: string;
}

/** Lean 4 Term Goal */
export interface LeanTermGoal {
  range: LspRange;
  goal: string;
}

/** Hover result */
export interface HoverResult {
  contents: string | { kind: string; value: string };
  range?: LspRange;
}

/** JSON-RPC Request */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

/** JSON-RPC Response */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** JSON-RPC Notification */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ============================================================================
// LSP Client Implementation
// ============================================================================

/**
 * Lean 4 LSP Client that communicates with `lake serve`.
 * Manages a persistent connection to the language server for rich diagnostics.
 */
export class LeanLspClient {
  private process: ResultPromise | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private buffer = '';
  private initialized = false;
  private projectRoot: string;
  private openFiles = new Set<string>();

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? WorkspaceFS.getPath() ?? process.cwd();
  }

  /**
   * Start the LSP server and initialize the connection.
   */
  async start(): Promise<void> {
    if (this.process) {
      return; // Already running
    }

    const env = { ...process.env };
    env.PATH = extendEnvPath(env.PATH);

    logger.info(CHANNEL, `Starting Lean LSP server in ${this.projectRoot}`);

    this.process = execa('lake', ['serve'], {
      cwd: this.projectRoot,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Handle stdout data
    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleData(data.toString());
    });

    // Handle stderr for logging
    this.process.stderr?.on('data', (data: Buffer) => {
      logger.debug(CHANNEL, `LSP stderr: ${data.toString().trim()}`);
    });

    // Handle process exit
    this.process.on('exit', (code) => {
      logger.info(CHANNEL, `LSP server exited with code ${code}`);
      this.process = null;
      this.initialized = false;
      this.openFiles.clear();
    });

    // Initialize the LSP connection
    await this.initialize();
  }

  /**
   * Stop the LSP server.
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    try {
      // Send shutdown request
      await this.sendRequest('shutdown', null);
      // Send exit notification
      this.sendNotification('exit', null);
    } catch {
      // Ignore errors during shutdown
    }

    this.process.kill();
    this.process = null;
    this.initialized = false;
    this.openFiles.clear();
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.process !== null && this.initialized;
  }

  /**
   * Get diagnostics for a file.
   */
  async getDiagnostics(filePath: string): Promise<LspDiagnostic[]> {
    await this.ensureFileOpen(filePath);

    // Diagnostics are pushed via notifications, but we can trigger a check
    // by making a small request. For now, return empty and rely on
    // textDocument/publishDiagnostics notifications
    // This is a limitation - we'd need to track diagnostics from notifications

    // Alternative: Use Lean's custom $/lean/plainGoal which returns diagnostics
    return [];
  }

  /**
   * Get the proof goal state at a position.
   * Uses Lean 4's custom $/lean/plainGoal request.
   */
  async getGoalState(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LeanGoalState | null> {
    await this.ensureFileOpen(filePath);

    const uri = this.filePathToUri(filePath);
    const params = {
      textDocument: { uri },
      position: { line, character },
    };

    try {
      const result = await this.sendRequest('$/lean/plainGoal', params);
      if (result && typeof result === 'object' && 'goals' in result) {
        return result as LeanGoalState;
      }
      // Handle rendered format
      if (result && typeof result === 'object' && 'rendered' in result) {
        const rendered = (result as { rendered: string }).rendered;
        return {
          goals: [rendered],
          rendered,
        };
      }
      return null;
    } catch (error) {
      logger.debug(CHANNEL, `getGoalState error: ${error}`);
      return null;
    }
  }

  /**
   * Get the term goal at a position.
   * Uses Lean 4's custom $/lean/plainTermGoal request.
   */
  async getTermGoal(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LeanTermGoal | null> {
    await this.ensureFileOpen(filePath);

    const uri = this.filePathToUri(filePath);
    const params = {
      textDocument: { uri },
      position: { line, character },
    };

    try {
      const result = await this.sendRequest('$/lean/plainTermGoal', params);
      return result as LeanTermGoal | null;
    } catch {
      return null;
    }
  }

  /**
   * Get hover information at a position.
   */
  async getHover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<HoverResult | null> {
    await this.ensureFileOpen(filePath);

    const uri = this.filePathToUri(filePath);
    const params = {
      textDocument: { uri },
      position: { line, character },
    };

    try {
      const result = await this.sendRequest('textDocument/hover', params);
      return result as HoverResult | null;
    } catch {
      return null;
    }
  }

  /**
   * Get completions at a position.
   */
  async getCompletions(
    filePath: string,
    line: number,
    character: number,
  ): Promise<unknown[]> {
    await this.ensureFileOpen(filePath);

    const uri = this.filePathToUri(filePath);
    const params = {
      textDocument: { uri },
      position: { line, character },
    };

    try {
      const result = await this.sendRequest('textDocument/completion', params);
      if (Array.isArray(result)) {
        return result;
      }
      if (result && typeof result === 'object' && 'items' in result) {
        return (result as { items: unknown[] }).items;
      }
      return [];
    } catch {
      return [];
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async initialize(): Promise<void> {
    const initParams = {
      processId: process.pid,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: {
            completionItem: { snippetSupport: false },
          },
        },
      },
      rootUri: this.filePathToUri(this.projectRoot),
      workspaceFolders: [
        {
          uri: this.filePathToUri(this.projectRoot),
          name: path.basename(this.projectRoot),
        },
      ],
    };

    await this.sendRequest('initialize', initParams);
    this.sendNotification('initialized', {});
    this.initialized = true;
    logger.info(CHANNEL, 'LSP server initialized');
  }

  private async ensureFileOpen(filePath: string): Promise<void> {
    if (!this.isRunning()) {
      await this.start();
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectRoot, filePath);

    if (this.openFiles.has(absolutePath)) {
      // Re-sync the file content
      await this.syncFile(absolutePath);
      return;
    }

    const uri = this.filePathToUri(absolutePath);
    const content = await fs.promises.readFile(absolutePath, 'utf-8');

    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'lean4',
        version: 1,
        text: content,
      },
    });

    this.openFiles.add(absolutePath);

    // Give the server a moment to process the file
    await this.waitForProcessing();
  }

  private async syncFile(filePath: string): Promise<void> {
    const uri = this.filePathToUri(filePath);
    const content = await fs.promises.readFile(filePath, 'utf-8');

    this.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: Date.now() },
      contentChanges: [{ text: content }],
    });

    await this.waitForProcessing();
  }

  private async waitForProcessing(ms: number = 500): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private filePathToUri(filePath: string): string {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.projectRoot, filePath);
    return `file://${absolutePath}`;
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('LSP server not running'));
        return;
      }

      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? undefined,
      };

      this.pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify(request);
      const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

      this.process.stdin.write(header + message);

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin) {
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params: params ?? undefined,
    };

    const message = JSON.stringify(notification);
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

    this.process.stdin.write(header + message);
  }

  private handleData(data: string): void {
    this.buffer += data;

    while (true) {
      // Parse Content-Length header
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        break;
      }

      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        // Invalid header, skip
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) {
        // Not enough data yet
        break;
      }

      const messageStr = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

      try {
        const message = JSON.parse(messageStr);
        this.handleMessage(message);
      } catch (error) {
        logger.error(CHANNEL, `Failed to parse LSP message: ${error}`);
      }
    }
  }

  private handleMessage(message: JsonRpcResponse | JsonRpcNotification): void {
    // Check if it's a response
    if ('id' in message && message.id !== undefined) {
      const response = message as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // It's a notification
    const notification = message as JsonRpcNotification;
    this.handleNotification(notification);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    switch (notification.method) {
      case 'textDocument/publishDiagnostics':
        // Could store these for later retrieval
        logger.debug(
          CHANNEL,
          `Received diagnostics: ${JSON.stringify(notification.params)}`,
        );
        break;
      case 'window/logMessage':
      case 'window/showMessage':
        logger.debug(
          CHANNEL,
          `LSP message: ${JSON.stringify(notification.params)}`,
        );
        break;
      default:
        logger.debug(CHANNEL, `Unhandled notification: ${notification.method}`);
    }
  }
}

// ============================================================================
// Singleton Instance Management
// ============================================================================

let clientInstance: LeanLspClient | null = null;

/**
 * Get or create the shared LSP client instance.
 */
export function getLspClient(projectRoot?: string): LeanLspClient {
  if (!clientInstance) {
    clientInstance = new LeanLspClient(projectRoot);
  }
  return clientInstance;
}

/**
 * Stop and dispose the shared LSP client.
 */
export async function disposeLspClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.stop();
    clientInstance = null;
  }
}
