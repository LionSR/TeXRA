// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, type ToolResult } from '@tools/result';
import { resolveAndFormat, formatResultCount } from '@tools/utils';
import { buildTimeoutMessage } from '@tools/timeouts';
import { defineTool } from '@tools/core/define';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { executeCommand } from '@utils/system/execUtils';

const CTAGS_TIMEOUT_MS = 30_000;

const ExtractCodeStructureInputSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'path is required.')
    .describe('Path to a source code file or directory.'),
  languages: z
    .string()
    .nullish()
    .describe(
      'Comma-separated ctags language filter (e.g. "Python,Julia"). Defaults to all.',
    ),
  max_depth: z
    .number()
    .int()
    .min(0)
    .max(10)
    .nullish()
    .describe('Maximum directory recursion depth for ctags (default: unlimited).'),
});

type ExtractCodeStructureInput = z.infer<
  typeof ExtractCodeStructureInputSchema
>;

interface CtagsTag {
  name: string;
  kind: string;
  line: number;
  path: string;
  scope?: string;
  signature?: string;
}

function parseCtagsJson(output: string): CtagsTag[] {
  const tags: CtagsTag[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj._type !== 'tag') continue;
      tags.push({
        name: obj.name,
        kind: obj.kind ?? '?',
        line: obj.line ?? 0,
        path: obj.path,
        scope: obj.scope ?? undefined,
        signature: obj.signature ?? undefined,
      });
    } catch {
      // skip unparseable lines
    }
  }
  return tags;
}

function formatTags(tags: CtagsTag[], basePath: string): string {
  // Group by file
  const byFile = new Map<string, CtagsTag[]>();
  for (const tag of tags) {
    const rel = path.relative(basePath, tag.path);
    const group = byFile.get(rel) ?? [];
    group.push(tag);
    byFile.set(rel, group);
  }

  const parts: string[] = [];
  for (const [file, fileTags] of byFile) {
    parts.push(`## ${file}`);
    fileTags.sort((a, b) => a.line - b.line);
    for (const tag of fileTags) {
      const scope = tag.scope ? ` (in ${tag.scope})` : '';
      const sig = tag.signature ?? '';
      parts.push(`  [${tag.kind}] ${tag.name}${sig}${scope} L${tag.line}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

export class ExtractCodeStructureTool extends defineTool({
  name: 'extract_code_structure',
  description:
    'Extract a structural overview of source code (classes, functions, types, modules) using Universal Ctags. Supports 40+ languages. Requires ctags to be installed.',
  schema: ExtractCodeStructureInputSchema,
}) {
  protected async execute(
    input: ExtractCodeStructureInput,
  ): Promise<ToolResult> {
    const { path: resolvedPath, display } = resolveAndFormat(input.path);

    const exists = await WorkspaceFS.exists(resolvedPath.relative);
    if (!exists) {
      throw new ToolError(`Path not found: ${display}`);
    }

    const args = [
      'ctags',
      '--output-format=json',
      '--fields=+nKsS',
      '-f', '-',
    ];

    if (input.languages) {
      args.push(`--languages=${input.languages}`);
    }

    if (input.max_depth != null) {
      args.push(`--maxdepth=${input.max_depth}`);
    }

    args.push('-R', resolvedPath.absolute);

    const result = await executeCommand(args.join(' '), {
      truncate: true,
      timeout: CTAGS_TIMEOUT_MS,
    });

    if (result.timedOut) {
      throw new ToolError(buildTimeoutMessage('ctags', CTAGS_TIMEOUT_MS));
    }

    if (!result.success) {
      const error = result.stderr || result.stdout || '';
      if (/not found|command not found/.test(error)) {
        throw new ToolError(
          'ctags is not installed. Install Universal Ctags: https://ctags.io',
        );
      }
      throw new ToolError(`ctags failed: ${error.slice(0, 1000)}`);
    }

    const tags = parseCtagsJson(result.stdout || '');
    if (tags.length === 0) {
      return {
        summary: `No code structures found in ${display}`,
        output: `No code structures found in ${display}.`,
      };
    }

    const basePath = path.dirname(resolvedPath.absolute);
    const output = formatTags(tags, basePath);
    const kinds = new Set(tags.map((t) => t.kind));

    return {
      summary: `${display}: ${formatResultCount(tags.length, 'symbol')} (${[...kinds].join(', ')})`,
      output,
    };
  }
}
