// Standard library imports
import * as fs from 'fs/promises';
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import type { ToolResult } from '@tools/result';

// Local imports - utils
import { AbsoluteFS } from '@utils/files';

// Local file imports
import { defineTool } from './core/define';

const MEMORY_ROOT = '/memories';
const LINE_NUMBER_WIDTH = 6;
const MAX_MEMORY_LINES = 999_999;
const LISTING_DEPTH = 2;

const ViewCommandSchema = z.strictObject({
  command: z.literal('view'),
  path: z.string(),
  view_range: z.tuple([z.int().min(1), z.int().min(1)]).nullish(),
});

const CreateCommandSchema = z.strictObject({
  command: z.literal('create'),
  path: z.string(),
  file_text: z.string(),
});

const StrReplaceCommandSchema = z.strictObject({
  command: z.literal('str_replace'),
  path: z.string(),
  old_str: z.string(),
  new_str: z.string(),
});

const InsertCommandSchema = z.strictObject({
  command: z.literal('insert'),
  path: z.string(),
  insert_line: z.int().min(0),
  insert_text: z.string(),
});

const DeleteCommandSchema = z.strictObject({
  command: z.literal('delete'),
  path: z.string(),
});

const RenameCommandSchema = z.strictObject({
  command: z.literal('rename'),
  old_path: z.string(),
  new_path: z.string(),
});

const MemoryToolInputSchema = z.discriminatedUnion('command', [
  ViewCommandSchema,
  CreateCommandSchema,
  StrReplaceCommandSchema,
  InsertCommandSchema,
  DeleteCommandSchema,
  RenameCommandSchema,
]);

export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

export class MemoryTool extends defineTool({
  name: 'memory',
  description:
    'Read and update persistent memory files under /memories using view, create, str_replace, insert, delete, or rename commands.',
  schema: MemoryToolInputSchema,
}) {
  protected async execute(input: MemoryToolInput): Promise<ToolResult> {
    switch (input.command) {
      case 'view':
        return this.handleView(input);
      case 'create':
        return this.handleCreate(input);
      case 'str_replace':
        return this.handleStrReplace(input);
      case 'insert':
        return this.handleInsert(input);
      case 'delete':
        return this.handleDelete(input);
      case 'rename':
        return this.handleRename(input);
      default:
        return { error: 'Unknown memory command', isError: true };
    }
  }

  private async handleView(
    input: z.infer<typeof ViewCommandSchema>,
  ): Promise<ToolResult> {
    if (!this.isValidMemoryPath(input.path)) {
      return this.pathNotFoundResult(input.path);
    }

    const exists = await AbsoluteFS.exists(input.path);
    if (!exists) {
      return this.pathNotFoundResult(input.path);
    }

    const isDir = await AbsoluteFS.isDir(input.path);
    if (isDir) {
      const listing = await this.buildDirectoryListing(input.path);
      return { output: listing };
    }

    const isFile = await AbsoluteFS.isFile(input.path);
    if (!isFile) {
      return this.pathNotFoundResult(input.path);
    }

    const content = await AbsoluteFS.read(input.path);
    const { lines } = this.splitLines(content);
    if (lines.length > MAX_MEMORY_LINES) {
      return {
        error: `File ${input.path} exceeds maximum line limit of 999,999 lines.`,
        isError: true,
      };
    }

    const output = this.formatFileView(input.path, lines, input.view_range);
    return { output };
  }

  private async handleCreate(
    input: z.infer<typeof CreateCommandSchema>,
  ): Promise<ToolResult> {
    if (!this.isValidMemoryPath(input.path)) {
      return this.pathNotFoundResult(input.path);
    }

    const exists = await AbsoluteFS.exists(input.path);
    if (exists) {
      return {
        error: `Error: File ${input.path} already exists`,
        isError: true,
      };
    }

    await AbsoluteFS.write(input.path, input.file_text);
    return { output: `File created successfully at: ${input.path}` };
  }

  private async handleStrReplace(
    input: z.infer<typeof StrReplaceCommandSchema>,
  ): Promise<ToolResult> {
    if (!this.isValidMemoryPath(input.path)) {
      return this.pathNotFoundResult(input.path);
    }

    const exists = await AbsoluteFS.exists(input.path);
    if (!exists || (await AbsoluteFS.isDir(input.path))) {
      return this.pathNotFoundResult(input.path);
    }

    const content = await AbsoluteFS.read(input.path);
    const occurrences = this.findOccurrences(content, input.old_str);

    if (occurrences.length === 0) {
      return {
        output: `No replacement was performed, old_str \`${input.old_str}\` did not appear verbatim in ${input.path}.`,
      };
    }

    if (occurrences.length > 1) {
      const lines = occurrences.map((occ) => occ.line).join(', ');
      return {
        output: `No replacement was performed. Multiple occurrences of old_str \`${input.old_str}\` in lines: ${lines}. Please ensure it is unique`,
      };
    }

    const updated = content.replace(input.old_str, input.new_str);
    await AbsoluteFS.write(input.path, updated);

    const { lines } = this.splitLines(updated);
    const formatted = this.formatFileView(input.path, lines, null);
    return {
      output: `The memory file has been edited.\n${formatted}`,
    };
  }

  private async handleInsert(
    input: z.infer<typeof InsertCommandSchema>,
  ): Promise<ToolResult> {
    if (!this.isValidMemoryPath(input.path)) {
      return {
        error: `Error: The path ${input.path} does not exist`,
        isError: true,
      };
    }

    const exists = await AbsoluteFS.exists(input.path);
    if (!exists || (await AbsoluteFS.isDir(input.path))) {
      return {
        error: `Error: The path ${input.path} does not exist`,
        isError: true,
      };
    }

    const content = await AbsoluteFS.read(input.path);
    const { lines, endsWithNewline } = this.splitLines(content);

    if (input.insert_line < 0 || input.insert_line > lines.length) {
      return {
        error: `Error: Invalid \`insert_line\` parameter: ${input.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`,
        isError: true,
      };
    }

    const updated = this.insertTextAtLine(
      lines,
      input.insert_line,
      input.insert_text,
      endsWithNewline,
    );
    await AbsoluteFS.write(input.path, updated);

    return { output: `The file ${input.path} has been edited.` };
  }

  private async handleDelete(
    input: z.infer<typeof DeleteCommandSchema>,
  ): Promise<ToolResult> {
    if (!this.isValidMemoryPath(input.path)) {
      return {
        error: `Error: The path ${input.path} does not exist`,
        isError: true,
      };
    }

    const exists = await AbsoluteFS.exists(input.path);
    if (!exists) {
      return {
        error: `Error: The path ${input.path} does not exist`,
        isError: true,
      };
    }

    await AbsoluteFS.delete(input.path, { recursive: true, useTrash: false });
    return { output: `Successfully deleted ${input.path}` };
  }

  private async handleRename(
    input: z.infer<typeof RenameCommandSchema>,
  ): Promise<ToolResult> {
    if (
      !this.isValidMemoryPath(input.old_path) ||
      !this.isValidMemoryPath(input.new_path)
    ) {
      return {
        error: `Error: The path ${input.old_path} does not exist`,
        isError: true,
      };
    }

    const exists = await AbsoluteFS.exists(input.old_path);
    if (!exists) {
      return {
        error: `Error: The path ${input.old_path} does not exist`,
        isError: true,
      };
    }

    const destinationExists = await AbsoluteFS.exists(input.new_path);
    if (destinationExists) {
      return {
        error: `Error: The destination ${input.new_path} already exists`,
        isError: true,
      };
    }

    await AbsoluteFS.rename(input.old_path, input.new_path);
    return {
      output: `Successfully renamed ${input.old_path} to ${input.new_path}`,
    };
  }

  private isValidMemoryPath(target: string): boolean {
    if (!target.startsWith(MEMORY_ROOT)) {
      return false;
    }
    const normalized = target.replaceAll('\\', '/');
    if (/%2e%2e/i.test(normalized)) {
      return false;
    }
    const segments = normalized.split('/');
    return !segments.includes('..');
  }

  private pathNotFoundResult(pathValue: string): ToolResult {
    return {
      error: `The path ${pathValue} does not exist. Please provide a valid path.`,
      isError: true,
    };
  }

  private splitLines(content: string): {
    lines: string[];
    endsWithNewline: boolean;
  } {
    const endsWithNewline = content.endsWith('\n');
    const lines = content.split('\n');
    if (endsWithNewline) {
      lines.pop();
    }
    return { lines, endsWithNewline };
  }

  private formatFileView(
    filePath: string,
    lines: string[],
    viewRange: [number, number] | null | undefined,
  ): string {
    const startLine = viewRange?.[0] ?? 1;
    const endLine = viewRange?.[1] ?? lines.length;
    const safeStart = Math.max(1, startLine);
    const safeEnd = Math.min(endLine, lines.length);
    const sliceStart = Math.min(safeStart - 1, lines.length);
    const sliceEnd = Math.max(sliceStart, safeEnd);
    const selected = lines.slice(sliceStart, sliceEnd);
    const formatted = selected.map((line, index) => {
      const lineNumber = (sliceStart + index + 1).toString();
      return `${lineNumber.padStart(LINE_NUMBER_WIDTH, ' ')}\t${line}`;
    });

    return `Here's the content of ${filePath} with line numbers:\n${formatted.join('\n')}`;
  }

  private async buildDirectoryListing(root: string): Promise<string> {
    const entries: Array<{ path: string; size: number }> = [];

    await this.collectDirectoryEntries(root, 0, entries);

    entries.sort((a, b) => a.path.localeCompare(b.path));

    const lines = entries.map((entry) => {
      const size = this.formatSize(entry.size);
      return `${size}\t${entry.path}`;
    });

    return `Here're the files and directories up to 2 levels deep in ${root}, excluding hidden items and node_modules:\n${lines.join('\n')}`;
  }

  private async collectDirectoryEntries(
    current: string,
    depth: number,
    entries: Array<{ path: string; size: number }>,
  ): Promise<void> {
    const stat = await fs.stat(current);
    entries.push({ path: current, size: stat.size });

    if (depth >= LISTING_DEPTH) {
      return;
    }

    const dirEntries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory() && depth + 1 <= LISTING_DEPTH) {
        await this.collectDirectoryEntries(entryPath, depth + 1, entries);
        continue;
      }
      const entryStat = await fs.stat(entryPath);
      entries.push({ path: entryPath, size: entryStat.size });
    }
  }

  private formatSize(size: number): string {
    if (size < 1024) {
      return `${size}B`;
    }

    const units = ['K', 'M', 'G', 'T'];
    let value = size;
    let unitIndex = -1;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }

    return `${value.toFixed(1)}${units[unitIndex]}`;
  }

  private findOccurrences(
    content: string,
    needle: string,
  ): Array<{ index: number; line: number }> {
    if (needle.length === 0) {
      return [];
    }

    const occurrences: Array<{ index: number; line: number }> = [];
    let searchIndex = 0;
    while (searchIndex <= content.length - needle.length) {
      const matchIndex = content.indexOf(needle, searchIndex);
      if (matchIndex === -1) {
        break;
      }
      const line = content.slice(0, matchIndex).split('\n').length;
      occurrences.push({ index: matchIndex, line });
      searchIndex = matchIndex + needle.length;
    }

    return occurrences;
  }

  private insertTextAtLine(
    lines: string[],
    insertLine: number,
    insertText: string,
    endsWithNewline: boolean,
  ): string {
    const before = lines.slice(0, insertLine).join('\n');
    const after = lines.slice(insertLine).join('\n');
    const needsLeadingNewline = before.length > 0;
    const needsTrailingNewline = after.length > 0;

    let updated = '';
    if (needsLeadingNewline) {
      updated += `${before}\n`;
    }
    updated += insertText;
    if (needsTrailingNewline) {
      if (!insertText.endsWith('\n')) {
        updated += '\n';
      }
      updated += after;
    }
    if (!needsTrailingNewline && endsWithNewline && !updated.endsWith('\n')) {
      updated += '\n';
    }

    return updated;
  }
}
