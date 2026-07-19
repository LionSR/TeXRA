import * as path from 'node:path';

import { listExecutionWorkspaceFiles } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { safeParseJson } from '@common/parsing/safeParseJson';
import type { ExecutionId } from '@shared/schemas';
import { isKVFile as isHistoryKvFile } from '@tools/executions/executionKvFiles';
import { StorageFS } from '@utils/files';
import { byStringProp, isObject } from '@utils/core';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe here since the input is a workspace-relative path produced by
// the storage directory walk below, not raw user input.
import { toPosixPath } from '@utils/core/pathCore';
import { isDirectory } from '@utils/files/fsEntryType';
import { findExistingRunStoragePath } from '@utils/files/taskRunStorage';

import type { CliHistoryFile } from '../history';

const HISTORY_FILE_SCAN_DEPTH = 2;
const WORKSPACE_FILE_TOOL_NAMES = new Set(['write_file', 'edit_file']);

export async function listGeneratedFiles(
  id: ExecutionId,
): Promise<CliHistoryFile[]> {
  const runDir = await findExistingRunStoragePath(id);
  if (!runDir) return [];
  return walkStorageDirectory(runDir, '', HISTORY_FILE_SCAN_DEPTH);
}

async function walkStorageDirectory(
  basePath: string,
  relativePath: string,
  maxDepth: number,
): Promise<CliHistoryFile[]> {
  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;
  const entries = await StorageFS.readDir(fullPath).catch((error: unknown) => {
    if (isFileNotFoundError(error)) return [];
    throw error;
  });

  const files: CliHistoryFile[] = [];
  for (const [name, type] of entries) {
    if (isHistoryKvFile(name)) continue;
    const rawRelative = relativePath ? path.join(relativePath, name) : name;
    const childPath = path.join(basePath, rawRelative);
    const entryIsDirectory = isDirectory(type);
    try {
      const stat = await StorageFS.stat(childPath);
      files.push({
        path: toPosixPath(rawRelative),
        size: stat.size,
        isDirectory: entryIsDirectory,
      });
    } catch (error) {
      if (isFileNotFoundError(error) || isNotADirectoryError(error)) continue;
      throw error;
    }
    if (entryIsDirectory && maxDepth > 1) {
      files.push(
        ...(await walkStorageDirectory(basePath, rawRelative, maxDepth - 1)),
      );
    }
  }
  return files.sort(byStringProp((f) => f.path));
}

export async function listWorkspaceToolFiles(
  config: AgentConfig | null,
  persistedPaths: readonly string[],
  conversation: readonly unknown[] | null,
): Promise<CliHistoryFile[]> {
  let filePaths: readonly string[];
  if (persistedPaths.length) {
    filePaths = persistedPaths;
  } else if (conversation?.length) {
    filePaths = extractWorkspaceFileToolPaths(conversation);
  } else {
    filePaths = [];
  }
  const workspaceFiles = await listExecutionWorkspaceFiles(config, filePaths);
  return workspaceFiles.map((file) => ({
    path: file.displayPath,
    size: file.size,
    isDirectory: file.isDirectory,
  }));
}

function extractWorkspaceFileToolPaths(
  conversation: readonly unknown[],
): string[] {
  const paths: string[] = [];
  for (const message of conversation) {
    if (!isObject(message)) continue;

    const responseToolPath = extractResponseFunctionCallFilePath(message);
    if (responseToolPath) paths.push(responseToolPath);

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    for (const toolCall of toolCalls) {
      const toolPath = extractOpenAiToolCallFilePath(toolCall);
      if (toolPath) paths.push(toolPath);
    }

    const contentBlocks = Array.isArray(message.content) ? message.content : [];
    for (const block of contentBlocks) {
      const toolPath = extractContentToolUseFilePath(block);
      if (toolPath) paths.push(toolPath);
    }

    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      const toolPath = extractGoogleFunctionCallFilePath(part);
      if (toolPath) paths.push(toolPath);
    }
  }
  return paths;
}

/**
 * Resolve the file-path argument of a `write_file` / `edit_file` tool call, or
 * undefined for any other tool. Shared by the per-provider extractors below,
 * which differ only in where the tool name and arguments are stored.
 */
function workspaceFileToolPath(
  name: unknown,
  argumentsValue: unknown,
): string | undefined {
  if (typeof name !== 'string' || !WORKSPACE_FILE_TOOL_NAMES.has(name)) {
    return undefined;
  }
  return extractToolArgumentsFilePath(argumentsValue);
}

function extractResponseFunctionCallFilePath(
  message: Record<string, unknown>,
): string | undefined {
  if (message.type !== 'function_call') return undefined;
  return workspaceFileToolPath(message.name, message.arguments);
}

function extractOpenAiToolCallFilePath(toolCall: unknown): string | undefined {
  if (!isObject(toolCall)) return undefined;
  const fn = isObject(toolCall.function) ? toolCall.function : {};
  return workspaceFileToolPath(fn.name, fn.arguments);
}

function extractContentToolUseFilePath(block: unknown): string | undefined {
  if (!isObject(block) || block.type !== 'tool_use') return undefined;
  return workspaceFileToolPath(block.name, block.input);
}

function extractGoogleFunctionCallFilePath(part: unknown): string | undefined {
  if (!isObject(part) || !isObject(part.functionCall)) return undefined;
  return workspaceFileToolPath(part.functionCall.name, part.functionCall.args);
}

function extractToolArgumentsFilePath(
  argumentsValue: unknown,
): string | undefined {
  const args = parseToolArguments(argumentsValue);
  const toolPath = typeof args?.path === 'string' ? args.path.trim() : '';
  return toolPath || undefined;
}

function parseToolArguments(
  argumentsValue: unknown,
): Record<string, unknown> | undefined {
  if (isObject(argumentsValue)) return argumentsValue;
  if (typeof argumentsValue !== 'string') return undefined;
  const parsed = safeParseJson(argumentsValue).unwrapOr(undefined);
  return isObject(parsed) ? parsed : undefined;
}

export function mergeHistoryFiles(
  ...fileGroups: readonly (readonly CliHistoryFile[])[]
): CliHistoryFile[] {
  const files = new Map<string, CliHistoryFile>();
  for (const group of fileGroups) {
    for (const file of group) {
      if (!files.has(file.path)) files.set(file.path, file);
    }
  }
  return [...files.values()].sort(byStringProp((f) => f.path));
}
