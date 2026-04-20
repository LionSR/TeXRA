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
    .prefault('added by TeXRA setup assistant')
    .describe(
      'Short descriptive note written as a comment (`#`) on the preceding line. Set to empty to skip. Any leading `#` or `<#`/`#>` is stripped; newlines are rejected.',
    ),
  profile: z
    .enum(['auto', 'zshrc', 'bashrc', 'profile', 'powershell'])
    .prefault('auto')
    .describe(
      'Which profile file to update. "auto" picks based on $SHELL on POSIX or the PowerShell profile on Windows.',
    ),
});

type UpdateShellRcInput = z.infer<typeof UpdateShellRcInputSchema>;

type Shell = 'posix' | 'powershell';

/**
 * Safe-line validator, scoped to the resolved target shell. Only allows a
 * single environment-variable assignment matching that shell's syntax —
 * the agent uses this tool specifically for PATH fixes after TeX installs,
 * nothing else.
 *
 *   - POSIX      `export NAME=value`
 *       Requires the `export` keyword (bare `NAME=value` is shell-local
 *       and does not propagate to child processes, so it silently fails
 *       as a PATH fix).
 *       Rejects `;`, `&`, `|`, `<`, `>`, backticks, `$(...)` — any of
 *       which can chain commands in sh/bash/zsh.
 *   - PowerShell `$env:NAME = value` / `[Environment]::SetEnvironmentVariable(...)`
 *       Rejects `&`, `|`, `<`, `>`, backticks, `$(...)`. `;` is
 *       intentionally allowed inside quoted strings (Windows PATH
 *       separator) but rejected outside quotes (statement separator).
 *
 * All forms reject newlines.
 */
const POSIX_SAFE_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+[A-Za-z_][A-Za-z0-9_]*=[^\r\n]*$/,
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

function isSafeLineFor(line: string, shell: Shell): boolean {
  if (shell === 'posix') {
    if (!POSIX_SAFE_PATTERNS.some((re) => re.test(line))) return false;
    return !POSIX_FORBIDDEN_SUBSTRINGS.some((s) => line.includes(s));
  }
  if (!POWERSHELL_SAFE_PATTERNS.some((re) => re.test(line))) return false;
  if (POWERSHELL_FORBIDDEN_SUBSTRINGS.some((s) => line.includes(s))) {
    return false;
  }
  return !hasUnquotedSemicolon(line);
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

function shellForProfile(profilePath: string): Shell {
  return profilePath.endsWith('.ps1') ? 'powershell' : 'posix';
}

/**
 * Normalize a user-supplied marker into a single comment line. Strips any
 * leading `#`, rejects embedded newlines, and rejects PowerShell block-
 * comment delimiters (`<#` / `#>`) so the marker is always a plain
 * single-line comment body — the `#` prefix is added by the caller.
 */
function normalizeMarker(raw: string): string {
  const trimmed = raw.trim().replace(/^#+\s*/, '');
  if (/[\r\n]/.test(trimmed)) {
    throw new ToolError(
      'marker must not contain newlines (would smuggle extra commands into the rc file).',
    );
  }
  if (trimmed.includes('<#') || trimmed.includes('#>')) {
    throw new ToolError(
      'marker must not contain PowerShell block-comment delimiters (`<#` or `#>`).',
    );
  }
  return trimmed;
}

/**
 * Append a single environment-variable assignment to the user's shell rc.
 *
 * Intentionally narrow:
 *   - one line, one file;
 *   - target shell is resolved first, then `line` is validated against
 *     only that shell's syntax (so a POSIX `export PATH=...` is never
 *     written to a PowerShell profile and vice versa);
 *   - marker is always written as a `# ...` comment — the leading `#` is
 *     added in code, never taken from the user, so a malicious marker
 *     cannot execute;
 *   - line-based idempotency (skips if the exact trimmed line already
 *     appears).
 *
 * The agent uses this specifically for post-install PATH fixes when TeX
 * binaries land outside the default `$PATH`.
 */
export class UpdateShellRcTool extends defineTool({
  name: 'update_shell_rc',
  description: `Append a single environment-variable assignment to the user's shell rc (~/.zshrc, ~/.bashrc, ~/.profile, or the PowerShell profile on Windows). The target shell is resolved first, then the input line is validated against only that shell's syntax — a POSIX \`export PATH=...\` targeting a PowerShell profile (or vice versa) is rejected. Command chaining (;, &&, ||, |), command substitution ($(...), \`...\`), redirection, and multi-line input are rejected. The marker is always written as a comment (\`#\` prefix added in code); any leading \`#\` in the input is stripped. Idempotent: skips if the exact trimmed line already appears.`,
  schema: UpdateShellRcInputSchema,
}) {
  protected async execute(input: UpdateShellRcInput): Promise<ToolResult> {
    const line = input.line.trim();
    if (!line) {
      throw new ToolError('Line cannot be empty or whitespace-only.');
    }

    const profilePath = resolveProfilePath(input.profile);
    const shell = shellForProfile(profilePath);

    if (!isSafeLineFor(line, shell)) {
      const expected =
        shell === 'posix'
          ? '`export NAME=value`'
          : '`$env:NAME = value` or `[Environment]::SetEnvironmentVariable(...)`';
      throw new ToolError(
        `Refusing to write "${line.slice(0, 80)}" to ${path.basename(profilePath)}: expected ${expected}. Command chaining, command substitution, redirection, and cross-shell syntax are rejected.`,
      );
    }

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

    const markerBody = normalizeMarker(input.marker);
    const commentLine = markerBody ? `# ${markerBody}` : '';

    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    const blockParts: string[] = [];
    if (needsLeadingNewline) blockParts.push('\n');
    if (existing.length > 0) blockParts.push('\n');
    if (commentLine) blockParts.push(`${commentLine}\n`);
    blockParts.push(`${line}\n`);
    const block = blockParts.join('');

    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.appendFile(profilePath, block, 'utf8');

    return {
      summary: `Appended to ${path.basename(profilePath)}`,
      output: `Appended to ${profilePath}:\n${commentLine ? `  ${commentLine}\n` : ''}  ${line}\n\nOpen a new terminal (or \`source\` the file) for the change to take effect.`,
    };
  }
}
