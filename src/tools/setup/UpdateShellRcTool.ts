// Standard library imports
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

// Third-party imports
import { z } from 'zod';

// Local imports
import { ToolError, type ToolResult } from '@tools/result';

// Local file imports
import { defineTool } from '../core/define';

const UpdateShellRcInputSchema = z.strictObject({
  line: z
    .string()
    .min(1)
    .describe(
      'The single line to append (e.g. `export PATH="/usr/local/texlive/2024/bin/universal-darwin:$PATH"`). Must be a single environment-variable assignment — arbitrary shell commands are rejected.',
    ),
  marker: z
    .string()
    .prefault('# added by TeXRA setup assistant')
    .describe(
      'Comment marker written on the preceding line so the addition is easy to find. Set to empty to skip.',
    ),
  profile: z
    .enum(['auto', 'zshrc', 'bashrc', 'profile', 'powershell'])
    .prefault('auto')
    .describe(
      'Which profile file to update. "auto" picks based on $SHELL on POSIX or the PowerShell profile on Windows.',
    ),
});

type UpdateShellRcInput = z.infer<typeof UpdateShellRcInputSchema>;

/**
 * Safe-line validator. Only allows single environment-variable assignments,
 * not arbitrary shell commands — the agent uses this tool specifically for
 * PATH fixes after TeX installs, nothing else.
 *
 * Accepted forms (and which metacharacters are rejected for each):
 *   - POSIX      `export NAME=value` / `NAME=value`
 *       Rejects `;`, `&`, `|`, `<`, `>`, backticks, `$(...)` (all of which
 *       can chain commands in sh/bash/zsh even inside partially-quoted
 *       values).
 *   - PowerShell `$env:NAME = value` / `[Environment]::SetEnvironmentVariable(...)`
 *       Rejects `&`, `|`, `<`, `>`, backticks, `$(...)`. `;` is
 *       intentionally ALLOWED because it is the Windows PATH separator
 *       (`$env:Path = "C:\texlive\2026\bin\win32;$env:Path"`).
 *
 * All forms reject newlines.
 */
const POSIX_SAFE_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+[A-Za-z_][A-Za-z0-9_]*=[^\r\n]*$/,
  /^\s*[A-Za-z_][A-Za-z0-9_]*=[^\r\n]*$/,
];

const POWERSHELL_SAFE_PATTERNS: readonly RegExp[] = [
  /^\s*\$env:[A-Za-z_][A-Za-z0-9_]*\s*=[^\r\n]*$/,
  /^\s*\[Environment\]::SetEnvironmentVariable\([^\r\n]*\)\s*$/,
];

const POSIX_FORBIDDEN_SUBSTRINGS: readonly string[] = [
  ';',
  '&',
  '|',
  '>',
  '<',
  '`',
  '$(',
  '\n',
  '\r',
];

const POWERSHELL_FORBIDDEN_SUBSTRINGS: readonly string[] = [
  '&',
  '|',
  '>',
  '<',
  '`',
  '$(',
  '\n',
  '\r',
];

/**
 * Scan `line` for a `;` that is not inside a single- or double-quoted
 * string. Used for the PowerShell accept path where `;` is a legitimate
 * PATH separator inside a quoted value (`"C:\foo;$env:Path"`) but also a
 * statement separator outside quotes (`$env:Path = "..."; Remove-Item ...`).
 * Backticks are already rejected by POWERSHELL_FORBIDDEN_SUBSTRINGS so we
 * do not need to handle PowerShell's backtick escape here.
 */
function hasUnquotedSemicolon(line: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ';' && !inSingle && !inDouble) return true;
  }
  return false;
}

function isSafeLine(line: string): boolean {
  if (POSIX_SAFE_PATTERNS.some((re) => re.test(line))) {
    return !POSIX_FORBIDDEN_SUBSTRINGS.some((s) => line.includes(s));
  }
  if (POWERSHELL_SAFE_PATTERNS.some((re) => re.test(line))) {
    if (POWERSHELL_FORBIDDEN_SUBSTRINGS.some((s) => line.includes(s))) {
      return false;
    }
    return !hasUnquotedSemicolon(line);
  }
  return false;
}

function resolveProfilePath(profile: UpdateShellRcInput['profile']): string {
  const home = os.homedir();

  if (profile === 'zshrc') return path.join(home, '.zshrc');
  if (profile === 'bashrc') return path.join(home, '.bashrc');
  if (profile === 'profile') return path.join(home, '.profile');
  if (profile === 'powershell') {
    return path.join(
      home,
      'Documents',
      'PowerShell',
      'Microsoft.PowerShell_profile.ps1',
    );
  }

  if (process.platform === 'win32') {
    return path.join(
      home,
      'Documents',
      'PowerShell',
      'Microsoft.PowerShell_profile.ps1',
    );
  }
  const shell = process.env.SHELL ?? '';
  if (shell.includes('zsh')) return path.join(home, '.zshrc');
  if (shell.includes('bash')) return path.join(home, '.bashrc');
  return path.join(home, '.profile');
}

/**
 * Append a single environment-variable assignment to the user's shell rc.
 *
 * Intentionally narrow:
 *   - one line, one file;
 *   - input must match an env-var assignment pattern (see `isSafeLine`);
 *   - line-based idempotency (skips if the exact trimmed line already appears).
 *
 * The agent uses this specifically for post-install PATH fixes when TeX
 * binaries land outside the default `$PATH`.
 */
export class UpdateShellRcTool extends defineTool({
  name: 'update_shell_rc',
  description: `Append a single environment-variable assignment to the user's shell rc (~/.zshrc, ~/.bashrc, ~/.profile, or the PowerShell profile on Windows). Only env-var assignments are accepted — command chaining (;, &&, ||, |), command substitution ($(...), \`...\`), redirection, and multi-line input are rejected. Idempotent: skips if the exact trimmed line already appears. Typical use: add a TeX Live bin directory to PATH after installing MacTeX/TeX Live when VS Code was launched without inheriting the shell PATH.`,
  schema: UpdateShellRcInputSchema,
}) {
  protected async execute(input: UpdateShellRcInput): Promise<ToolResult> {
    const line = input.line.trim();
    if (!line) {
      throw new ToolError('Line cannot be empty or whitespace-only.');
    }

    if (!isSafeLine(line)) {
      throw new ToolError(
        `Refusing to write "${line.slice(0, 80)}": update_shell_rc only accepts environment-variable assignments (e.g. \`export PATH=...\`, \`$env:Path = ...\`). Command chaining, command substitution, and redirection are rejected.`,
      );
    }

    const profilePath = resolveProfilePath(input.profile);

    let existing = '';
    try {
      existing = await fs.readFile(profilePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    const existingLines = existing.split('\n').map((l) => l.trim());
    if (existingLines.includes(line)) {
      return {
        summary: `Shell rc already contains the line`,
        output: `${profilePath} already contains:\n  ${line}\nNo change made.`,
      };
    }

    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    const blockParts: string[] = [];
    if (needsLeadingNewline) blockParts.push('\n');
    if (existing.length > 0) blockParts.push('\n');
    const marker = input.marker.trim();
    if (marker) {
      if (/[\r\n]/.test(marker)) {
        throw new ToolError(
          'marker must not contain newlines (would let extra commands be smuggled into the rc file).',
        );
      }
      blockParts.push(`${marker}\n`);
    }
    blockParts.push(`${line}\n`);
    const block = blockParts.join('');

    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.appendFile(profilePath, block, 'utf8');

    return {
      summary: `Appended to ${path.basename(profilePath)}`,
      output: `Appended to ${profilePath}:\n${marker ? `  ${marker}\n` : ''}  ${line}\n\nOpen a new terminal (or \`source\` the file) for the change to take effect.`,
    };
  }
}
