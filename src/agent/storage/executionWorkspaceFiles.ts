import * as path from 'node:path';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { safeParseJson } from '@common/parsing/safeParseJson';
import type { FileStat } from '@platform/interfaces';
import { AbsoluteFS } from '@utils/files';
import { byStringProp, isObject, normalizeFilePath } from '@utils/core';
import { isStrictlyWithin } from '@utils/core/pathCore';
import { isDirectory } from '@utils/files/fsEntryType';

const WORKSPACE_FILE_TOOL_NAMES = new Set(['write_file', 'edit_file']);

export interface ExecutionWorkspaceFile {
  readonly path: string;
  readonly displayPath: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

export function resolveExecutionWorkspaceFilePath(
  config: Pick<AgentConfig, 'workingDirectory'> | null,
  filePath: string,
): { readonly absolutePath: string; readonly path: string } | undefined {
  const workspaceRoot = config?.workingDirectory?.trim();
  const cleanedPath = filePath.trim();
  if (!workspaceRoot || !cleanedPath) return undefined;

  const absoluteRoot = path.resolve(workspaceRoot);
  const absolutePath = path.isAbsolute(cleanedPath)
    ? path.normalize(cleanedPath)
    : path.resolve(absoluteRoot, cleanedPath);
  const relativePath = path.relative(absoluteRoot, absolutePath);
  if (!isStrictlyWithin(absoluteRoot, absolutePath)) {
    return undefined;
  }

  return {
    absolutePath,
    path: normalizeFilePath(relativePath),
  };
}

export async function listExecutionWorkspaceFiles(
  config: Pick<AgentConfig, 'workingDirectory'> | null,
  filePaths: readonly string[],
): Promise<ExecutionWorkspaceFile[]> {
  const files = new Map<string, ExecutionWorkspaceFile>();
  for (const filePath of filePaths) {
    const resolved = resolveExecutionWorkspaceFilePath(config, filePath);
    if (!resolved || files.has(resolved.path)) continue;

    let stat: FileStat;
    try {
      stat = await AbsoluteFS.stat(resolved.absolutePath);
    } catch (error) {
      if (isFileNotFoundError(error) || isNotADirectoryError(error)) continue;
      throw error;
    }

    files.set(resolved.path, {
      path: resolved.path,
      displayPath: `workspace/${resolved.path}`,
      absolutePath: resolved.absolutePath,
      size: stat.size,
      isDirectory: isDirectory(stat.type),
    });
  }
  return [...files.values()].sort(byStringProp((f) => f.path));
}

/**
 * Workspace files an execution edited, for history surfaces.
 *
 * The persisted workspace-file list is authoritative whenever the run recorded
 * one. Only the tool-use flow writes it, so an empty list on a tool-use run can
 * mean the run predates that write rather than that it edited nothing, and the
 * `write_file` / `edit_file` paths still recoverable from the conversation fill
 * the gap. A workflow run never writes the list at all, so its empty list says
 * nothing about what it touched and deriving files from its conversation would
 * be a guess: it stays empty.
 */
export async function listExecutionEditedFiles(
  config: Pick<AgentConfig, 'workingDirectory' | 'agentCategory'> | null,
  persistedPaths: readonly string[],
  conversation: readonly unknown[] | null,
): Promise<ExecutionWorkspaceFile[]> {
  const useFallback =
    persistedPaths.length === 0 &&
    config?.agentCategory === AgentCategory.ToolUse;
  return listExecutionWorkspaceFiles(
    config,
    useFallback
      ? extractWorkspaceFileToolPaths(conversation ?? [])
      : persistedPaths,
  );
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
