// Local imports - hosts
import type {
  DiffOptions,
  DiffSession,
  DiffSource,
  DiffViewHost,
  ExternalOpener,
  PromptConfirmOptions,
  PromptHost,
  PromptInputOptions,
  PromptMessageOptions,
} from '@hosts/uiHosts';

export type PromptEventKind = 'info' | 'warning' | 'error';

export interface PromptMessageEvent {
  kind: PromptEventKind;
  message: string;
  options?: PromptMessageOptions;
}

export interface PromptConfirmEvent {
  message: string;
  options?: PromptConfirmOptions;
}

export interface PromptInputEvent {
  options: PromptInputOptions;
}

interface DiffOpenEvent {
  original: DiffSource;
  proposed: DiffSource;
  title: string;
  options?: DiffOptions;
}

interface DiffRevealEvent {
  session: DiffSession;
  line: number;
}

export interface FakeUIHostsOptions {
  promptResponses?: readonly string[];
  confirmResponses?: readonly boolean[];
  inputResponses?: readonly (string | undefined)[];
  proposedDiffContent?: Record<string, string>;
}

export class FakePromptHost implements PromptHost {
  readonly messages: PromptMessageEvent[] = [];

  readonly confirms: PromptConfirmEvent[] = [];

  readonly inputs: PromptInputEvent[] = [];

  private readonly promptResponses: string[];

  private readonly confirmResponses: boolean[];

  private readonly inputResponses: (string | undefined)[];

  constructor(
    options: Pick<
      FakeUIHostsOptions,
      'promptResponses' | 'confirmResponses' | 'inputResponses'
    > = {},
  ) {
    this.promptResponses = [...(options.promptResponses ?? [])];
    this.confirmResponses = [...(options.confirmResponses ?? [])];
    this.inputResponses = [...(options.inputResponses ?? [])];
  }

  async info<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Promise<T | undefined> {
    return this.recordMessage('info', message, options);
  }

  async warning<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Promise<T | undefined> {
    return this.recordMessage('warning', message, options);
  }

  async error<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Promise<T | undefined> {
    return this.recordMessage('error', message, options);
  }

  async confirm(
    message: string,
    options?: PromptConfirmOptions,
  ): Promise<boolean> {
    this.confirms.push({ message, options });
    return this.confirmResponses.shift() ?? false;
  }

  async input(options: PromptInputOptions): Promise<string | undefined> {
    this.inputs.push({ options });
    const response = this.inputResponses.shift();
    if (response == null) {
      return response;
    }

    const validationMessage = await options.validateInput?.(response);
    return validationMessage == null ? response : undefined;
  }

  private recordMessage<T extends string>(
    kind: PromptEventKind,
    message: string,
    options?: PromptMessageOptions<T>,
  ): T | undefined {
    this.messages.push({ kind, message, options });
    return this.promptResponses.shift() as T | undefined;
  }
}

class FakeExternalOpener implements ExternalOpener {
  readonly externalUrls: string[] = [];

  readonly paths: string[] = [];

  async openExternal(url: string): Promise<void> {
    this.externalUrls.push(url);
  }

  async openPath(filePath: string): Promise<void> {
    this.paths.push(filePath);
  }
}

class FakeDiffViewHost implements DiffViewHost {
  readonly opened: DiffOpenEvent[] = [];

  readonly closed: DiffSession[] = [];

  readonly revealed: DiffRevealEvent[] = [];

  private readonly proposedContent = new Map<string, string>();

  constructor(proposedContent: Record<string, string> = {}) {
    for (const [filePath, content] of Object.entries(proposedContent)) {
      this.proposedContent.set(filePath, content);
    }
  }

  async openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
    options?: DiffOptions,
  ): Promise<DiffSession> {
    this.opened.push({ original, proposed, title, options });
    return { original, proposed, title };
  }

  async closeDiff(session: DiffSession): Promise<void> {
    this.closed.push(session);
  }

  async revealFirstChange(session: DiffSession, line: number): Promise<void> {
    this.revealed.push({ session, line });
  }

  async readProposedContent(session: DiffSession): Promise<string> {
    const content = this.proposedContent.get(session.proposed.filePath);
    if (content === undefined) {
      throw new Error(
        `No proposed diff content for ${session.proposed.filePath}.`,
      );
    }
    return content;
  }

  setProposedContent(filePath: string, content: string): void {
    this.proposedContent.set(filePath, content);
  }
}

/**
 * The three UI ports a host wires together. Production hosts (VS Code,
 * desktop) inject each port individually; this aggregate exists only so
 * test support can assemble and pass them as a single bundle.
 */
interface UIHosts {
  readonly prompt: PromptHost;
  readonly externalOpener: ExternalOpener;
  readonly diff: DiffViewHost;
}

export interface FakeUIHosts extends UIHosts {
  readonly prompt: FakePromptHost;
  readonly externalOpener: FakeExternalOpener;
  readonly diff: FakeDiffViewHost;
}

export function createFakeUIHosts(
  options: FakeUIHostsOptions = {},
): FakeUIHosts {
  return {
    prompt: new FakePromptHost(options),
    externalOpener: new FakeExternalOpener(),
    diff: new FakeDiffViewHost(options.proposedDiffContent),
  };
}
