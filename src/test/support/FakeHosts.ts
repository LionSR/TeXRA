// Local imports - hosts
import type { ClipboardHost } from '@hosts/clipboardHost';
import type {
  DiffOptions,
  DiffSession,
  DiffSource,
  DiffViewHost,
} from '@hosts/diffViewHost';
import type { ExternalOpener } from '@hosts/externalOpener';
import type {
  PromptConfirmOptions,
  PromptHost,
  PromptInputOptions,
  PromptMessageOptions,
} from '@hosts/promptHost';
import type {
  TerminalHandle,
  TerminalHost,
  TerminalOptions,
} from '@hosts/terminalHost';
import type { UIHosts } from '@hosts/uiHosts';

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

export interface DiffOpenEvent {
  original: DiffSource;
  proposed: DiffSource;
  title: string;
  options?: DiffOptions;
}

export interface DiffRevealEvent {
  session: DiffSession;
  line: number;
}

export interface TerminalSendEvent {
  text: string;
  shouldExecute?: boolean;
}

export interface TerminalShowEvent {
  preserveFocus?: boolean;
}

export interface FakeUIHostsOptions {
  promptResponses?: readonly string[];
  confirmResponses?: readonly boolean[];
  inputResponses?: readonly (string | undefined)[];
  clipboardText?: string;
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

export class FakeExternalOpener implements ExternalOpener {
  readonly externalUrls: string[] = [];

  readonly paths: string[] = [];

  async openExternal(url: string): Promise<void> {
    this.externalUrls.push(url);
  }

  async openPath(filePath: string): Promise<void> {
    this.paths.push(filePath);
  }
}

export class FakeClipboardHost implements ClipboardHost {
  readonly writes: string[] = [];

  constructor(private text = '') {}

  async readText(): Promise<string> {
    return this.text;
  }

  async writeText(text: string): Promise<void> {
    this.text = text;
    this.writes.push(text);
  }
}

export class FakeDiffViewHost implements DiffViewHost {
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

  async readProposedContent(
    session: DiffSession,
    fallbackContent: string,
  ): Promise<string> {
    return (
      this.proposedContent.get(session.proposed.filePath) ?? fallbackContent
    );
  }

  setProposedContent(filePath: string, content: string): void {
    this.proposedContent.set(filePath, content);
  }
}

export class FakeTerminalHost implements TerminalHost {
  readonly created: FakeTerminalHandle[] = [];

  createTerminal(options: TerminalOptions): FakeTerminalHandle {
    const terminal = new FakeTerminalHandle(options);
    this.created.push(terminal);
    return terminal;
  }

  findTerminal(name: string): TerminalHandle | undefined {
    const terminal = this.created.find(
      (terminal) => terminal.name === name && !terminal.isDisposed,
    );
    return terminal?.createLookupHandle();
  }

  getTerminals(): readonly TerminalHandle[] {
    return this.created
      .filter((terminal) => !terminal.isDisposed)
      .map((terminal) => terminal.createLookupHandle());
  }
}

interface FakeTerminalState {
  sentText: TerminalSendEvent[];
  showCalls: TerminalShowEvent[];
  isDisposed: boolean;
}

export class FakeTerminalHandle implements TerminalHandle {
  constructor(
    readonly options: TerminalOptions,
    private readonly state: FakeTerminalState = {
      sentText: [],
      showCalls: [],
      isDisposed: false,
    },
  ) {}

  get sentText(): readonly TerminalSendEvent[] {
    return this.state.sentText;
  }

  get showCalls(): readonly TerminalShowEvent[] {
    return this.state.showCalls;
  }

  get isDisposed(): boolean {
    return this.state.isDisposed;
  }

  get name(): string {
    return this.options.name;
  }

  sendText(text: string, shouldExecute?: boolean): void {
    this.state.sentText.push({ text, shouldExecute });
  }

  show(preserveFocus?: boolean): void {
    this.state.showCalls.push({ preserveFocus });
  }

  dispose(): void {
    this.state.isDisposed = true;
  }

  createLookupHandle(): FakeTerminalHandle {
    return new FakeTerminalHandle(this.options, this.state);
  }
}

export interface FakeUIHosts extends UIHosts {
  readonly prompt: FakePromptHost;
  readonly externalOpener: FakeExternalOpener;
  readonly diff: FakeDiffViewHost;
  readonly terminal: FakeTerminalHost;
  readonly clipboard: FakeClipboardHost;
}

export function createFakeUIHosts(
  options: FakeUIHostsOptions = {},
): FakeUIHosts {
  return {
    prompt: new FakePromptHost(options),
    externalOpener: new FakeExternalOpener(),
    diff: new FakeDiffViewHost(options.proposedDiffContent),
    terminal: new FakeTerminalHost(),
    clipboard: new FakeClipboardHost(options.clipboardText),
  };
}
