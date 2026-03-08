import * as path from 'path';

import { z } from 'zod';

import { isDirectory } from '@common/files/fsEntryType';
import { AbsoluteFS } from '@utils/files';
import { splitContentLines } from '@utils/text/stringUtils';

import { defineTool } from './core/define';
import { ToolError, type ToolResult } from './result';
import { formatLinesWithNumbers, requireField } from './utils';
import { resolveVirtualPath } from './virtualPaths';

const AgentsToolInputSchema = z.strictObject({
  command: z.enum(['list', 'read', 'write', 'search']),
  path: z.string().nullish(),
  content: z.string().nullish(),
  pattern: z.string().nullish(),
});

export type AgentsToolInput = z.infer<typeof AgentsToolInputSchema>;

export class AgentsTool extends defineTool({
  name: 'agents',
  description: `Browse and manage agent definitions under /agents (list, read, write, search).

Paths must start with /agents. Directories: /agents/builtin (workflow), /agents/tooluse (tool-use), /agents/custom (your agents, writable), /agents/docs (reference docs).`,
  schema: AgentsToolInputSchema,
}) {
  protected async execute(input: AgentsToolInput): Promise<ToolResult> {
    switch (input.command) {
      case 'list':
        return this.list(requireField(input.path, 'path', 'list'));
      case 'read':
        return this.read(requireField(input.path, 'path', 'read'));
      case 'write':
        return this.write(
          requireField(input.path, 'path', 'write'),
          requireField(input.content, 'content', 'write'),
        );
      case 'search':
        return this.search(
          requireField(input.pattern, 'pattern', 'search'),
          input.path ?? undefined,
        );
      default:
        throw new ToolError(`Unknown command: ${input.command}`);
    }
  }

  private resolve(inputPath: string) {
    const virtual = resolveVirtualPath(inputPath);
    if (!virtual) {
      throw new ToolError(
        `Invalid path "${inputPath}". Paths must start with /agents/ (e.g., /agents/builtin, /agents/custom/my_agent.yaml).`,
      );
    }
    return virtual;
  }

  private async list(inputPath: string): Promise<ToolResult> {
    const virtual = this.resolve(inputPath);

    const exists = await AbsoluteFS.exists(virtual.absolutePath);
    if (!exists) {
      throw new ToolError(`Directory not found: ${inputPath}`);
    }

    const isDir = await AbsoluteFS.isDir(virtual.absolutePath);
    if (!isDir) {
      throw new ToolError(`Not a directory: ${inputPath}`);
    }

    const entries = await AbsoluteFS.readDir(virtual.absolutePath);
    const lines: string[] = [];
    for (const [name, type] of entries) {
      lines.push(isDirectory(type) ? `${name}/` : name);
    }
    lines.sort();

    const rw = virtual.writable ? 'read-write' : 'read-only';
    return {
      summary: `Listed ${inputPath}: ${lines.length} entries`,
      output: `${inputPath} (${rw}, ${lines.length} entries)\n${lines.length > 0 ? lines.join('\n') : '(empty)'}`,
    };
  }

  private async read(inputPath: string): Promise<ToolResult> {
    const virtual = this.resolve(inputPath);

    const exists = await AbsoluteFS.exists(virtual.absolutePath);
    if (!exists) {
      throw new ToolError(`File not found: ${inputPath}`);
    }

    const content = await AbsoluteFS.read(virtual.absolutePath);
    const lines = splitContentLines(content);
    const numbered = formatLinesWithNumbers(lines);

    return {
      summary: `Read ${inputPath} (${lines.length} lines)`,
      output: numbered.join('\n'),
    };
  }

  private async write(inputPath: string, content: string): Promise<ToolResult> {
    const virtual = this.resolve(inputPath);

    if (!virtual.writable) {
      throw new ToolError(
        `Cannot write to ${inputPath} — read-only. Use /agents/custom/ instead.`,
      );
    }

    await AbsoluteFS.ensureDir(path.dirname(virtual.absolutePath));
    await AbsoluteFS.write(virtual.absolutePath, content);
    const lineCount = content.split('\n').length;

    return {
      summary: `Wrote ${inputPath} (${lineCount} lines)`,
      output: `Written. The agent will appear in the dropdown.`,
    };
  }

  private async search(
    pattern: string,
    scopePath?: string,
  ): Promise<ToolResult> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      throw new ToolError(`Invalid pattern: ${pattern}`);
    }

    const dirs = scopePath
      ? [scopePath]
      : ['/agents/builtin', '/agents/tooluse', '/agents/custom', '/agents/docs'];

    const results: string[] = [];

    for (const dir of dirs) {
      const virtual = resolveVirtualPath(dir);
      if (!virtual) continue;

      const exists = await AbsoluteFS.exists(virtual.absolutePath);
      if (!exists) continue;

      const isDir = await AbsoluteFS.isDir(virtual.absolutePath);
      if (!isDir) continue;

      const entries = await AbsoluteFS.readDir(virtual.absolutePath);
      for (const [name, type] of entries) {
        if (isDirectory(type)) continue;
        try {
          const filePath = path.join(virtual.absolutePath, name);
          const content = await AbsoluteFS.read(filePath);
          const lines = splitContentLines(content);
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push(`${dir}/${name}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        } catch {
          // skip unreadable
        }
      }
    }

    return {
      summary: `Searched for "${pattern}": ${results.length} matches`,
      output:
        results.length > 0
          ? results.join('\n')
          : `No matches for "${pattern}"`,
    };
  }
}
