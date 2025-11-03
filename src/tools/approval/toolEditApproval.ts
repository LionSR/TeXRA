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
import { safeExecuteCommand } from '@utils/system/commandUtils';

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

type ApprovalResolutionSource = 'progressView' | 'notification' | 'dismiss';

interface PendingApprovalEntry {
  request: ToolEditApprovalRequest;
  originalUri: vscode.Uri;
  proposedUri: vscode.Uri;
  originalContent: string;
  proposedContent: string;
  title: string;
  isSettled: () => boolean;
  settle: (
    result: ToolEditApprovalResult,
    source: ApprovalResolutionSource,
  ) => void;
}

interface ProgressViewApprovalActionPayload {
  requestId: string;
  action: 'approve' | 'reject' | 'openDiff';
  note?: string;
}

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
let approvalCounter = 0;
const pendingApprovals = new Map<string, PendingApprovalEntry>();

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

function createApprovalRequestId(): string {
  approvalCounter += 1;
  return `approval-${Date.now().toString(36)}-${approvalCounter}`;
}

async function showProgressViewApprovalPrompt(
  requestId: string,
  request: ToolEditApprovalRequest,
  relativePath: string,
): Promise<void> {
  await safeExecuteCommand('texra.showProgressView');

  try {
    const { ProgressViewProvider } = await import(
      '@progressView/ProgressViewProvider'
    );
    const provider = ProgressViewProvider.getInstance();
    provider?.showToolEditApprovalPrompt({
      requestId,
      path: request.path,
      relativePath,
      sourceTool: request.sourceTool,
    });
  } catch (error) {
    console.warn('Unable to show progress view approval prompt', error);
  }
}

async function resolveProgressViewApprovalPrompt(
  requestId: string,
): Promise<void> {
  try {
    const { ProgressViewProvider } = await import(
      '@progressView/ProgressViewProvider'
    );
    ProgressViewProvider.getInstance()?.resolveToolEditApprovalPrompt(
      requestId,
    );
  } catch (error) {
    console.warn('Unable to resolve progress view approval prompt', error);
  }
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

async function closeApprovalEditors(
  originalUri: vscode.Uri,
  proposedUri: vscode.Uri,
): Promise<void> {
  const targetUris = new Set([originalUri.toString(), proposedUri.toString()]);

  const tabsToClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        typeof vscode.TabInputTextDiff !== 'undefined' &&
        input instanceof vscode.TabInputTextDiff
      ) {
        const original = input.original.toString();
        const modified = input.modified.toString();
        if (targetUris.has(original) && targetUris.has(modified)) {
          tabsToClose.push(tab);
        }
        continue;
      }

      if (
        typeof vscode.TabInputText !== 'undefined' &&
        input instanceof vscode.TabInputText
      ) {
        if (targetUris.has(input.uri.toString())) {
          tabsToClose.push(tab);
        }
      }
    }
  }

  if (tabsToClose.length > 0) {
    await vscode.window.tabGroups.close(tabsToClose);
  }
}

async function nativeRequestApproval(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  if (!initialized || !registration) {
    throw new Error('Tool edit approval has not been initialized.');
  }

  const { path, originalContent, proposedContent, sourceTool } = request;

  const requestId = createApprovalRequestId();
  const originalUri = createVirtualUri(path, 'original', sourceTool);
  const proposedUri = createVirtualUri(path, 'proposed', sourceTool);

  provider.set(originalUri, originalContent);
  provider.set(proposedUri, proposedContent);

  const description = vscode.workspace.asRelativePath(
    WorkspaceFS.fullPath(path),
  );

  const title = `Tool edit (${sourceTool}): ${description}`;
  let result: ToolEditApprovalResult = { accepted: false };
  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      title,
    );

    await revealFirstChange(proposedUri, originalContent, proposedContent);

    result = await new Promise<ToolEditApprovalResult>((resolve) => {
      let settled = false;

      const settle = (
        value: ToolEditApprovalResult,
        source: ApprovalResolutionSource,
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        pendingApprovals.delete(requestId);
        if (source === 'progressView') {
          void safeExecuteCommand('workbench.action.closeMessages');
        }
        resolve(value);
      };

      const entry: PendingApprovalEntry = {
        request,
        originalUri,
        proposedUri,
        originalContent,
        proposedContent,
        title,
        isSettled: () => settled,
        settle,
      };

      pendingApprovals.set(requestId, entry);
      void showProgressViewApprovalPrompt(requestId, request, description);

      const approve: vscode.MessageItem = { title: 'Approve' };
      const reject: vscode.MessageItem = {
        title: 'Reject',
        isCloseAffordance: true,
      };

      void vscode.window
        .showInformationMessage(
          `Apply changes from ${sourceTool} to ${description}?`,
          {
            detail:
              'Review the diff in the editor. This notification stays open until you respond.',
            modal: false,
          },
          approve,
          reject,
        )
        .then(
          async (selection) => {
            if (settled) {
              return;
            }

            if (selection === approve) {
              settle({ accepted: true }, 'notification');
              return;
            }

            if (selection === reject) {
              const userMessage = await vscode.window.showInputBox({
                prompt: 'Optionally share why the change was rejected',
                placeHolder:
                  'Add guidance for the assistant (press Enter to skip)',
              });
              settle(
                {
                  accepted: false,
                  userMessage: userMessage?.trim() || undefined,
                },
                'notification',
              );
              return;
            }

            settle(
              {
                accepted: false,
                userMessage: 'User dismissed the approval notification.',
              },
              'dismiss',
            );
          },
          (error: unknown) => {
            if (settled) {
              return;
            }
            console.warn('Approval notification failed', error);
            settle(
              {
                accepted: false,
                userMessage: 'Approval prompt failed to display.',
              },
              'dismiss',
            );
          },
        );
    });

    return result;
  } finally {
    pendingApprovals.delete(requestId);
    await closeApprovalEditors(originalUri, proposedUri);
    provider.delete(originalUri);
    provider.delete(proposedUri);
    await resolveProgressViewApprovalPrompt(requestId);
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

export async function handleProgressViewToolEditApprovalAction(
  payload: ProgressViewApprovalActionPayload,
): Promise<void> {
  const entry = pendingApprovals.get(payload.requestId);
  if (!entry) {
    return;
  }

  if (payload.action === 'openDiff') {
    if (entry.isSettled()) {
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      entry.originalUri,
      entry.proposedUri,
      entry.title,
    );
    await revealFirstChange(
      entry.proposedUri,
      entry.originalContent,
      entry.proposedContent,
    );
    return;
  }

  if (entry.isSettled()) {
    return;
  }

  if (payload.action === 'approve') {
    entry.settle({ accepted: true }, 'progressView');
    return;
  }

  if (payload.action === 'reject') {
    let userMessage = payload.note?.trim();
    if (!userMessage) {
      const note = await vscode.window.showInputBox({
        prompt: 'Optionally share why the change was rejected',
        placeHolder: 'Add guidance for the assistant (press Enter to skip)',
      });
      userMessage = note?.trim();
    }

    entry.settle(
      {
        accepted: false,
        userMessage: userMessage || undefined,
      },
      'progressView',
    );
  }
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
