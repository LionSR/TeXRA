// Local imports - CLI runtime
import { writeRawStderr, writeTextStderr } from '../runtime/logSinks';

interface ChatSessionMetadata {
  readonly agent: string;
  readonly model: string;
  readonly cwd: string;
}

type TerminalTone = 'muted' | 'success' | 'warning' | 'error' | 'accent';

const ANSI_RESET = '\u001B[0m';
const ANSI_TONES: Record<TerminalTone, string> = {
  muted: '\u001B[2m',
  success: '\u001B[32m',
  warning: '\u001B[33m',
  error: '\u001B[31m',
  accent: '\u001B[36m',
};

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export class ChatTerminalRenderer {
  readonly prompt = 'user> ';

  constructor(private readonly colorEnabled: boolean) {}

  printBanner(metadata: ChatSessionMetadata): void {
    const cwd = basename(metadata.cwd);
    this.info(
      `texra chat plain mode. Agent: ${metadata.agent}. Model: ${metadata.model}. Workspace: ${cwd}. Type /help for commands.`,
    );
  }

  printHelp(): void {
    this.info(`Commands:
  /help            Show this help
  /agent <name>    Set the tool-use agent before the session starts
  /model <name>    Set the model before the session starts
  /yolo            Explain yolo approval mode
  /clear           Clear the terminal
  /exit, /quit     Exit chat`);
  }

  printClearScreen(): void {
    writeRawStderr('\u001B[2J\u001B[H');
  }

  info(message: string): void {
    this.write('accent', message);
  }

  success(message: string): void {
    this.write('success', message);
  }

  warn(message: string): void {
    this.write('warning', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  private write(tone: TerminalTone, message: string): void {
    if (!this.colorEnabled) {
      writeTextStderr(message);
      return;
    }
    writeTextStderr(`${ANSI_TONES[tone]}${message}${ANSI_RESET}`);
  }
}
