// Standard library imports
import * as fs from 'fs/promises';
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tools
import { ToolError, type ToolResult } from '@tools/result';
import { resolveAndFormat, formatResultCount } from '@tools/utils';
import { defineTool } from '@tools/core/define';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';

/**
 * Language-specific regex patterns for extracting code structure.
 * Each pattern captures the definition line (signature) of structural elements.
 */
interface LanguagePatterns {
  /** Matches class/type definitions */
  classes: RegExp;
  /** Matches function/method definitions */
  functions: RegExp;
  /** Matches import/include statements */
  imports: RegExp;
  /** Matches decorator/attribute lines (grouped with following definition) */
  decorators?: RegExp;
}

const PYTHON_PATTERNS: LanguagePatterns = {
  classes: /^(\s*class\s+\w+[^:]*:)/,
  functions: /^(\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)[^:]*:)/,
  imports: /^((?:from\s+\S+\s+)?import\s+.+)/,
  decorators: /^(\s*@\w+)/,
};

const JULIA_PATTERNS: LanguagePatterns = {
  classes: /^(\s*(?:abstract\s+type|(?:mutable\s+)?struct)\s+\w+)/,
  functions: /^(\s*function\s+\w+[^)]*\))/,
  imports: /^(\s*(?:using|import)\s+.+)/,
};

const TYPESCRIPT_PATTERNS: LanguagePatterns = {
  classes:
    /^(\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+\w+)/,
  functions:
    /^(\s*(?:export\s+)?(?:async\s+)?(?:function\s+\w+|(?:const|let)\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>))/,
  imports: /^(\s*import\s+.+)/,
  decorators: /^(\s*@\w+)/,
};

const RUST_PATTERNS: LanguagePatterns = {
  classes: /^(\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+\w+)/,
  functions: /^(\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+)/,
  imports: /^(\s*(?:use|mod)\s+.+)/,
};

const CPP_PATTERNS: LanguagePatterns = {
  classes: /^(\s*(?:class|struct|enum(?:\s+class)?|namespace)\s+\w+)/,
  functions:
    /^(\s*(?:(?:static|virtual|inline|extern|constexpr)\s+)*(?:\w+(?:::\w+)*\s+)+\w+\s*\([^;{]*\)(?:\s*(?:const|override|noexcept|final))*\s*\{?)/,
  imports: /^(\s*#\s*include\s+.+)/,
};

const R_PATTERNS: LanguagePatterns = {
  classes: /^(\s*(?:setClass|setRefClass|R6Class)\s*\()/,
  functions: /^(\s*(\w+)\s*<-\s*function\s*\()/,
  imports: /^(\s*(?:library|require)\s*\(.+\))/,
};

const MATLAB_PATTERNS: LanguagePatterns = {
  classes: /^(\s*classdef\s+\w+)/,
  functions: /^(\s*function\s+.+)/,
  imports: /^(\s*(?:import|addpath)\s+.+)/,
};

/** Map file extensions to language patterns. */
const EXTENSION_TO_PATTERNS: Record<string, LanguagePatterns> = {
  '.py': PYTHON_PATTERNS,
  '.pyx': PYTHON_PATTERNS,
  '.jl': JULIA_PATTERNS,
  '.ts': TYPESCRIPT_PATTERNS,
  '.tsx': TYPESCRIPT_PATTERNS,
  '.js': TYPESCRIPT_PATTERNS,
  '.jsx': TYPESCRIPT_PATTERNS,
  '.rs': RUST_PATTERNS,
  '.c': CPP_PATTERNS,
  '.cpp': CPP_PATTERNS,
  '.cc': CPP_PATTERNS,
  '.cxx': CPP_PATTERNS,
  '.h': CPP_PATTERNS,
  '.hpp': CPP_PATTERNS,
  '.r': R_PATTERNS,
  '.R': R_PATTERNS,
  '.m': MATLAB_PATTERNS,
};

/** Detect language from file extension. */
function detectPatterns(filePath: string): LanguagePatterns | null {
  const ext = path.extname(filePath);
  return EXTENSION_TO_PATTERNS[ext] ?? null;
}

interface StructureEntry {
  kind: 'import' | 'class' | 'function' | 'decorator';
  line: number;
  text: string;
  indent: number;
}

/** Extract structural elements from source code using language patterns. */
function extractStructure(
  content: string,
  patterns: LanguagePatterns,
): StructureEntry[] {
  const entries: StructureEntry[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const indent = line.search(/\S/);
    if (indent < 0) continue;

    if (patterns.decorators?.test(line)) {
      entries.push({
        kind: 'decorator',
        line: lineNum,
        text: line.trimEnd(),
        indent,
      });
      continue;
    }

    if (patterns.imports.test(line)) {
      entries.push({
        kind: 'import',
        line: lineNum,
        text: line.trim(),
        indent,
      });
      continue;
    }

    if (patterns.classes.test(line)) {
      entries.push({
        kind: 'class',
        line: lineNum,
        text: line.trimEnd(),
        indent,
      });
      continue;
    }

    if (patterns.functions.test(line)) {
      entries.push({
        kind: 'function',
        line: lineNum,
        text: line.trimEnd(),
        indent,
      });
    }
  }

  return entries;
}

/**
 * Extract the docstring following a class or function definition.
 * Returns the first line of the docstring, or null if none found.
 */
function extractDocstring(
  lines: string[],
  defLineIndex: number,
): string | null {
  // Look at the next non-empty line after the definition
  for (
    let i = defLineIndex + 1;
    i < Math.min(defLineIndex + 5, lines.length);
    i++
  ) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Python docstrings: """ or '''
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      const quote = trimmed.slice(0, 3);
      // Single-line docstring
      if (trimmed.endsWith(quote) && trimmed.length > 6) {
        return trimmed.slice(3, -3).trim();
      }
      // First line of multi-line docstring
      const firstLine = trimmed.slice(3).trim();
      return firstLine || null;
    }

    // JSDoc: /** ... */
    if (trimmed.startsWith('/**')) {
      const content = trimmed.replace(/^\/\*\*\s*/, '').replace(/\s*\*\/$/, '');
      return content.trim() || null;
    }

    // Rust/Julia doc comments: /// or #
    if (trimmed.startsWith('///') || trimmed.startsWith('#=')) {
      return (
        trimmed
          .replace(/^\/\/\/\s*/, '')
          .replace(/^#=\s*/, '')
          .trim() || null
      );
    }

    break;
  }
  return null;
}

/** Format extracted structure into a readable tree representation. */
function formatStructure(
  filePath: string,
  content: string,
  entries: StructureEntry[],
): string {
  const lines = content.split('\n');
  const parts: string[] = [`## ${filePath}`];

  // Group imports
  const imports = entries.filter((e) => e.kind === 'import');
  if (imports.length > 0) {
    parts.push('');
    parts.push('### Imports');
    for (const imp of imports) {
      parts.push(`  ${imp.text}`);
    }
  }

  // Group classes and functions (preserving decorators)
  const definitions = entries.filter((e) => e.kind !== 'import');
  if (definitions.length > 0) {
    parts.push('');
    parts.push('### Definitions');

    let pendingDecorators: string[] = [];

    for (const entry of definitions) {
      if (entry.kind === 'decorator') {
        pendingDecorators.push(entry.text);
        continue;
      }

      const prefix = entry.kind === 'class' ? '[class]' : '[func]';
      const lineRef = `L${entry.line}`;

      // Include decorators inline
      if (pendingDecorators.length > 0) {
        for (const dec of pendingDecorators) {
          parts.push(`  ${dec}`);
        }
        pendingDecorators = [];
      }

      // Extract docstring for context
      const docstring = extractDocstring(lines, entry.line - 1);
      const docNote = docstring ? `  -- ${docstring}` : '';

      parts.push(`  ${prefix} ${entry.text.trim()} (${lineRef})${docNote}`);
    }
  }

  if (definitions.length === 0 && imports.length === 0) {
    parts.push('  (no recognized structural elements)');
  }

  return parts.join('\n');
}

/** Maximum file size to process (500 KB). */
const MAX_FILE_SIZE = 500 * 1024;

/** Maximum number of files to process in a directory scan. */
const MAX_FILES = 50;

const ExtractCodeStructureInputSchema = z.strictObject({
  path: z
    .string()
    .min(1, 'path is required.')
    .describe(
      'Path to a source code file or directory. For directories, scans supported file types recursively.',
    ),
  max_depth: z
    .number()
    .int()
    .min(0)
    .max(10)
    .nullish()
    .describe(
      'Maximum directory recursion depth (default: 3). Only used when path is a directory.',
    ),
});

type ExtractCodeStructureInput = z.infer<
  typeof ExtractCodeStructureInputSchema
>;

/**
 * Recursively collect supported source files from a directory.
 */
async function collectSourceFiles(
  dirAbsolute: string,
  maxDepth: number,
  currentDepth: number = 0,
): Promise<string[]> {
  if (currentDepth > maxDepth) return [];

  const entries = await fs.readdir(dirAbsolute, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    // Skip hidden directories and common non-source dirs
    if (
      entry.name.startsWith('.') ||
      entry.name === 'node_modules' ||
      entry.name === '__pycache__' ||
      entry.name === 'venv' ||
      entry.name === '.git'
    ) {
      continue;
    }

    const fullPath = path.join(dirAbsolute, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await collectSourceFiles(
        fullPath,
        maxDepth,
        currentDepth + 1,
      );
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (EXTENSION_TO_PATTERNS[ext]) {
        files.push(fullPath);
      }
    }

    if (files.length >= MAX_FILES) break;
  }

  return files;
}

export class ExtractCodeStructureTool extends defineTool({
  name: 'extract_code_structure',
  description:
    'Extract a high-level structural overview of source code files: classes, functions, imports, and docstrings. Supports Python, Julia, TypeScript/JavaScript, Rust, C/C++, R, and MATLAB. Use this to efficiently understand a codebase before creating presentations or documentation.',
  schema: ExtractCodeStructureInputSchema,
}) {
  protected async execute(
    input: ExtractCodeStructureInput,
  ): Promise<ToolResult> {
    const { path: resolvedPath, display } = resolveAndFormat(input.path);
    const maxDepth = input.max_depth ?? 3;

    const exists = await WorkspaceFS.exists(resolvedPath.relative);
    if (!exists) {
      throw new ToolError(`Path not found: ${display}`);
    }

    const stat = await fs.stat(resolvedPath.absolute);

    if (stat.isFile()) {
      return this.processFile(resolvedPath.absolute, display);
    }

    if (stat.isDirectory()) {
      return this.processDirectory(resolvedPath.absolute, display, maxDepth);
    }

    throw new ToolError(`Unsupported path type: ${display}`);
  }

  private async processFile(
    absolutePath: string,
    display: string,
  ): Promise<ToolResult> {
    const patterns = detectPatterns(absolutePath);
    if (!patterns) {
      const ext = path.extname(absolutePath);
      const supported = Object.keys(EXTENSION_TO_PATTERNS).join(', ');
      throw new ToolError(
        `Unsupported file type '${ext}'. Supported extensions: ${supported}`,
      );
    }

    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new ToolError(
        `File too large (${(stat.size / 1024).toFixed(0)} KB). Maximum: ${MAX_FILE_SIZE / 1024} KB.`,
      );
    }

    const content = await fs.readFile(absolutePath, 'utf-8');
    const entries = extractStructure(content, patterns);
    const output = formatStructure(display, content, entries);

    const classCount = entries.filter((e) => e.kind === 'class').length;
    const funcCount = entries.filter((e) => e.kind === 'function').length;

    return {
      summary: `${display}: ${formatResultCount(classCount, 'class', 'classes')}, ${formatResultCount(funcCount, 'function')}`,
      output,
    };
  }

  private async processDirectory(
    absolutePath: string,
    display: string,
    maxDepth: number,
  ): Promise<ToolResult> {
    const files = await collectSourceFiles(absolutePath, maxDepth);

    if (files.length === 0) {
      return {
        summary: `No supported source files found in ${display}`,
        output: `No supported source files found in ${display}.\nSupported extensions: ${Object.keys(EXTENSION_TO_PATTERNS).join(', ')}`,
      };
    }

    const limitedFiles = files.slice(0, MAX_FILES);
    const outputs: string[] = [];
    let totalClasses = 0;
    let totalFunctions = 0;

    for (const filePath of limitedFiles) {
      const patterns = detectPatterns(filePath);
      if (!patterns) continue;

      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;

        const content = await fs.readFile(filePath, 'utf-8');
        const entries = extractStructure(content, patterns);

        // Compute workspace-relative path for display
        const relPath = path.relative(
          WorkspaceFS.getPath() ?? absolutePath,
          filePath,
        );
        outputs.push(formatStructure(relPath, content, entries));

        totalClasses += entries.filter((e) => e.kind === 'class').length;
        totalFunctions += entries.filter((e) => e.kind === 'function').length;
      } catch {
        // Skip unreadable files
      }
    }

    const summaryParts = [
      `${display}: ${formatResultCount(limitedFiles.length, 'file')}`,
      `${formatResultCount(totalClasses, 'class', 'classes')}`,
      `${formatResultCount(totalFunctions, 'function')}`,
    ];

    if (files.length > MAX_FILES) {
      summaryParts.push(`(limited to first ${MAX_FILES} files)`);
    }

    return {
      summary: summaryParts.join(', '),
      output: outputs.join('\n\n'),
    };
  }
}
