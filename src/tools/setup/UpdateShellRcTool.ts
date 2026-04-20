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
      'The single line to append (e.g. `export PATH="/usr/local/texlive/2024/bin/universal-darwin:$PATH"`). A trailing newline is added automatically.',
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

function resolveProfilePath(profile: UpdateShellRcInput['profile']): string {
  const home = os.homedir();

  if (profile === 'zshrc') return path.join(home, '.zshrc');
  if (profile === 'bashrc') return path.join(home, '.bashrc');
  if (profile === 'profile') return path.join(home, '.profile');
  if (profile === 'powershell') {
    // PowerShell uses Documents\PowerShell\Microsoft.PowerShell_profile.ps1
    return path.join(
      home,
      'Documents',
      'PowerShell',
      'Microsoft.PowerShell_profile.ps1',
    );
  }

  // auto
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
 * Append a single line (typically a PATH export) to the user's shell rc.
 *
 * Intentionally narrow: one line, one file, idempotent (skips if the exact
 * line is already present). The agent uses this specifically for post-
 * install PATH fixes when TeX binaries land outside the default `$PATH`.
 */
export class UpdateShellRcTool extends defineTool({
  name: 'update_shell_rc',
  description: `Append a single line to the user's shell rc (~/.zshrc, ~/.bashrc, ~/.profile, or the PowerShell profile on Windows). Idempotent — skips if the exact line is already present. Typical use: add a TeX Live bin directory to PATH after installing MacTeX/TeX Live when VS Code was launched without inheriting the shell PATH. A comment marker is written above the new line so the user can trace where it came from.`,
  schema: UpdateShellRcInputSchema,
}) {
  protected async execute(input: UpdateShellRcInput): Promise<ToolResult> {
    const line = input.line.trim();
    if (!line) {
      throw new ToolError('Line cannot be empty or whitespace-only.');
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

    if (existing.includes(line)) {
      return {
        summary: `Shell rc already contains the line`,
        output: `${profilePath} already contains:\n  ${line}\nNo change made.`,
      };
    }

    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const marker = input.marker.trim();
    const block =
      (marker ? `${prefix}\n${marker}\n` : `${prefix}\n`) + `${line}\n`;

    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.appendFile(profilePath, block, 'utf8');

    return {
      summary: `Appended to ${path.basename(profilePath)}`,
      output: `Appended to ${profilePath}:\n${marker ? `  ${marker}\n` : ''}  ${line}\n\nOpen a new terminal (or \`source\` the file) for the change to take effect.`,
    };
  }
}
