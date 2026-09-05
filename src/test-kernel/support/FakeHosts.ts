// Local imports - hosts
import type {
  ExternalOpener,
  PromptConfirmOptions,
  PromptHost,
  PromptInputOptions,
  PromptMessageOptions,
} from '@hosts/uiHosts';

type PromptEventKind = 'info' | 'warning' | 'error';

interface PromptMessageEvent {
  kind: PromptEventKind;
  message: string;
  options?: PromptMessageOptions;
}

interface PromptConfirmEvent {
  message: string;
  options?: PromptConfirmOptions;
}

interface PromptInputEvent {
  options: PromptInputOptions;
}

export interface FakeUIHostsOptions {
  promptResponses?: readonly string[];
  confirmResponses?: readonly boolean[];
  inputResponses?: readonly (string | undefined)[];
}

class FakePromptHost implements PromptHost {
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
    return this.inputResponses.shift();
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

  async openExternal(url: string): Promise<void> {
    this.externalUrls.push(url);
  }
}

/**
 * The UI ports a host wires together. Production hosts (VS Code, desktop)
 * inject each port individually; this aggregate exists only so test support
 * can assemble and pass them as a single bundle.
 */
export interface FakeUIHosts {
  readonly prompt: FakePromptHost;
  readonly externalOpener: FakeExternalOpener;
}

export function createFakeUIHosts(
  options: FakeUIHostsOptions = {},
): FakeUIHosts {
  return {
    prompt: new FakePromptHost(options),
    externalOpener: new FakeExternalOpener(),
  };
}
