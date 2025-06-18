// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

const STORAGE_PREFIX = 'storage://';
const CHANNEL = 'workspaceStorageUtils';
logger.initialize(CHANNEL);

/**
 * Check if a path is a storage path (starts with storage://)
 */
export function isStoragePath(filePath: string): boolean {
  return filePath.startsWith(STORAGE_PREFIX);
}

/**
 * Parse a storage path and return the relative path within storage
 * @param storagePath Path like "storage://pasted/file.png"
 * @returns Relative path within storage like "pasted/file.png"
 */
export function parseStoragePath(storagePath: string): string {
  if (!isStoragePath(storagePath)) {
    throw new Error(`Not a storage path: ${storagePath}`);
  }
  return storagePath.substring(STORAGE_PREFIX.length);
}

/**
 * Convert a storage path to an absolute filesystem path
 * @param storagePath Path like "storage://pasted/file.png"
 * @param context Extension context for getting storage path
 * @returns Absolute filesystem path
 */
export function storagePathToAbsolute(
  storagePath: string,
  context: vscode.ExtensionContext,
): string {
  const relativePath = parseStoragePath(storagePath);
  if (!context.storageUri) {
    throw new Error('Storage URI not available');
  }
  return path.join(context.storageUri.fsPath, relativePath);
}

/**
 * Create a storage path from a relative path
 * @param relativePath Relative path within storage
 * @returns Storage path like "storage://pasted/file.png"
 */
export function createStoragePath(relativePath: string): string {
  return `${STORAGE_PREFIX}${relativePath}`;
}

// Global storage context for resolving paths
let globalStorageContext: vscode.ExtensionContext | null = null;

/**
 * Set the global storage context
 */
export function setStorageContext(context: vscode.ExtensionContext): void {
  globalStorageContext = context;
}

/**
 * Get the global storage context
 */
export function getStorageContext(): vscode.ExtensionContext | null {
  return globalStorageContext;
}

/**
 * Get the workspace storage path from context
 */
export function getWorkspaceStoragePath(
  context: vscode.ExtensionContext,
): string {
  if (!context.storageUri) {
    throw new Error('Workspace storage path not available');
  }
  return context.storageUri.fsPath;
}

/**
 * Create a directory in workspace storage
 */
export async function createStorageDirectory(
  context: vscode.ExtensionContext,
  relativePath: string,
): Promise<void> {
  const basePath = getWorkspaceStoragePath(context);
  const fullPath = path.join(basePath, relativePath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(fullPath));
}

/**
 * Write binary content to a file in workspace storage
 */
export async function writeBinaryFileToStorage(
  context: vscode.ExtensionContext,
  filePath: string,
  content: Uint8Array,
): Promise<void> {
  const basePath = getWorkspaceStoragePath(context);
  const fullPath = path.join(basePath, filePath);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(fullPath), content);
}

/**
 * Write UTF-8 text to a file in workspace storage
 */
export async function writeFileToStorage(
  context: vscode.ExtensionContext,
  filePath: string,
  content: string,
): Promise<void> {
  await writeBinaryFileToStorage(
    context,
    filePath,
    Buffer.from(content, 'utf-8'),
  );
}

/**
 * Read UTF-8 text from a file in workspace storage
 */
export async function readFileFromStorage(
  context: vscode.ExtensionContext,
  filePath: string,
): Promise<string> {
  const basePath = getWorkspaceStoragePath(context);
  const fullPath = path.join(basePath, filePath);
  const data = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
  return Buffer.from(data).toString('utf-8');
}

/**
 * Clean up old files in a storage directory
 */
export async function cleanupStorageDirectory(
  context: vscode.ExtensionContext,
  relativePath: string,
  maxAgeMs: number,
): Promise<void> {
  try {
    const basePath = getWorkspaceStoragePath(context);
    const fullPath = path.join(basePath, relativePath);
    const dirUri = vscode.Uri.file(fullPath);
    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const now = Date.now();

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) {
        continue;
      }
      const fileUri = vscode.Uri.file(path.join(fullPath, name));
      try {
        const stat = await vscode.workspace.fs.stat(fileUri);
        if (now - stat.mtime > maxAgeMs) {
          await vscode.workspace.fs.delete(fileUri, { useTrash: false });
          logger.debug(
            CHANNEL,
            `Deleted old storage file: ${path.join(relativePath, name)}`,
          );
        }
      } catch (e) {
        logger.warn(
          CHANNEL,
          `Error cleaning file ${name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Error cleaning storage directory ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
