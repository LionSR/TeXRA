import { Effect } from 'effect';
import * as vscode from 'vscode';

import type { SessionHandle } from '@agent/runtime';
import {
  getFileListConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { withLogChannel } from '@logger/effectLog';

import { getFilesRecursively } from './listing';

const CHANNEL = 'FileLister';

export class FileLister {
  public static initialize(
    context: vscode.ExtensionContext,
    session: SessionHandle,
  ): void {
    instance = new FileLister(session);
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        getFileLister().refresh(),
      ),
    );
  }

  private workspacePath: string | undefined;

  constructor(private readonly session: SessionHandle) {
    this.refresh();
  }

  public refresh(): void {
    this.workspacePath = this.session.roots.workspace;
  }

  /** The workspace listing, with VS Code's file search wrapped once. */
  public list(fileType: ListableFileType): Effect.Effect<string[]> {
    const root = this.workspacePath;
    if (!root) {
      return Effect.logWarning('No workspace folder found').pipe(
        withLogChannel(CHANNEL),
        Effect.as([]),
      );
    }
    return Effect.promise(() =>
      getFilesRecursively(root, getFileListConfig(fileType)),
    );
  }
}

let instance: FileLister | undefined;

/** The lister created by {@link FileLister.initialize} during activation. */
export function getFileLister(): FileLister {
  if (!instance) {
    throw new Error(
      'FileLister has not been initialized. Call FileLister.initialize() during activation.',
    );
  }
  return instance;
}
