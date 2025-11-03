// Third-party imports
import {
  diff_match_patch,
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
} from 'diff-match-patch';
import * as vscode from 'vscode';

// Local imports - utils
import { toolResult, type ToolResult } from '@tools/result';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config';

export interface ToolEditApprovalRequest {
  path: string;
  originalContent: string;
  proposedContent: string;
  sourceTool: string;
}

export interface ToolEditApprovalResult {
  accepted: boolean;
  userMessage?: string;
}

export const TOOL_EDIT_APPROVAL_CONFIG_KEY =
  'texra.toolUse.requireEditApproval';

const APPROVAL_SCHEME = 'texra-tool-edit';

class ToolEditContentProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();

  public readonly onDidChange = this.emitter.event;

  public set(uri: vscode.Uri, value: string): void {
    const key = uri.toString();
    this.content.set(key, value);
    this.emitter.fire(uri);
  }

  public delete(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.content.delete(key)) {
      this.emitter.fire(uri);
    }
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? '';
  }

  public dispose(): void {
    this.emitter.dispose();
    this.content.clear();
  }
}

const provider = new ToolEditContentProvider();
let registration: vscode.Disposable | undefined;
let queue: Promise<void> = Promise.resolve();
let initialized = false;
let customHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;

export function initializeToolEditApproval(
  context: vscode.ExtensionContext,
): void {
  if (initialized) {
    return;
  }

  registration = vscode.workspace.registerTextDocumentContentProvider(
    APPROVAL_SCHEME,
    provider,
  );
  context.subscriptions.push(provider, registration);
  initialized = true;
}

export function setToolEditApprovalHandler(
  handler?: (
    request: ToolEditApprovalRequest,
  ) => Promise<ToolEditApprovalResult>,
): void {
  customHandler = handler;
}

function createVirtualUri(
  path: string,
  side: 'original' | 'proposed',
  sourceTool: string,
): vscode.Uri {
  const encodedPath = encodeURIComponent(path);
  const encodedTool = encodeURIComponent(sourceTool);
  const nonce = Date.now().toString(36);
  return vscode.Uri.parse(
    `${APPROVAL_SCHEME}://${side}/${encodedTool}/${encodedPath}?t=${nonce}`,
  );
}

function countNewlines(value: string): number {
  return (value.match(/\n/g) ?? []).length;
}

function firstChangedLine(original: string, proposed: string): number | null {
  if (original === proposed) {
    return null;
  }

  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(original, proposed);
  dmp.diff_cleanupSemantic(diffs);

  let originalLine = 0;
  let proposedLine = 0;

  for (const [type, text] of diffs) {
    switch (type) {
      case DIFF_EQUAL: {
        const newlineCount = countNewlines(text);
        originalLine += newlineCount;
        proposedLine += newlineCount;
        break;
      }
      case DIFF_INSERT:
        return proposedLine;
      case DIFF_DELETE:
        return Math.max(proposedLine - 1, 0);
      default:
        break;
    }
  }

  return 0;
}

async function revealFirstChange(
  proposedUri: vscode.Uri,
  originalContent: string,
  proposedContent: string,
): Promise<void> {
  const line = firstChangedLine(originalContent, proposedContent);
  if (line === null) {
    return;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) =>
        candidate.document.uri.toString() === proposedUri.toString(),
    );

    if (editor) {
      const position = new vscode.Position(line, 0);
      editor.selections = [new vscode.Selection(position, position)];
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter,
      );
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await vscode.commands.executeCommand(
    'workbench.action.compareEditor.nextChange',
  );
}

async function nativeRequestApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  if (!initialized || !registration) {
    throw new Error('Tool edit approval has not been initialized.');
  }

  const { path, originalContent, proposedContent, sourceTool } = request;

  const originalUri = createVirtualUri(path, 'original', sourceTool);
  const proposedUri = createVirtualUri(path, 'proposed', sourceTool);

  provider.set(originalUri, originalContent);
  provider.set(proposedUri, proposedContent);

  const description = vscode.workspace.asRelativePath(
    WorkspaceFS.fullPath(path),
  );

  const title = `Tool edit (${sourceTool}): ${description}`;

  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      title,
    );

    await revealFirstChange(proposedUri, originalContent, proposedContent);

    const approve = 'Approve';
    const reject = 'Reject';
    const selection = await vscode.window.showInformationMessage(
      `Apply changes from ${sourceTool} to ${description}?`,
      { detail: 'Review the diff, then choose an action.', modal: true },
      approve,
      reject,
    );

    if (selection === approve) {
      return { accepted: true };
    }

    if (selection === reject) {
      const userMessage = await vscode.window.showInputBox({
        prompt: 'Optionally share why the change was rejected',
        placeHolder: 'Add guidance for the assistant (press Enter to skip)',
      });
      return {
        accepted: false,
        userMessage: userMessage?.trim() || undefined,
      };
    }

    return {
      accepted: false,
      userMessage: 'User dismissed the approval dialog.',
    };
  } finally {
    provider.delete(originalUri);
    provider.delete(proposedUri);
  }
}

async function enqueueApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  const run = async () =>
    customHandler ? customHandler(request) : nativeRequestApproval(request);

  const operation = queue.then(run);
  queue = operation.then(
    () => {},
    () => {},
  );
  return operation;
}

export async function requestToolEditApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  const approvalsEnabled = getConfig<boolean>(
    TOOL_EDIT_APPROVAL_CONFIG_KEY,
    true,
  );

  if (!approvalsEnabled) {
    return { accepted: true };
  }

  return enqueueApproval(request);
}

export function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  userMessage?: string,
): ToolResult {
  return toolResult({
    summary: `User rejected ${sourceTool} for ${path}`,
    error: userMessage ?? `User rejected ${sourceTool} for ${path}.`,
    isError: true,
    output: userMessage,
  });
}
