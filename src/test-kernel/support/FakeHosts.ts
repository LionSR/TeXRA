// Third-party imports
import { Effect } from 'effect';

// Local imports - hosts
import type {
  ExternalOpenFailed,
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

  info<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined> {
    return Effect.sync(() => this.recordMessage('info', message, options));
  }

  warning<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined> {
    return Effect.sync(() => this.recordMessage('warning', message, options));
  }

  error<T extends string = string>(
    message: string,
    options?: PromptMessageOptions<T>,
  ): Effect.Effect<T | undefined> {
    return Effect.sync(() => this.recordMessage('error', message, options));
  }

  confirm(
    message: string,
    options?: PromptConfirmOptions,
  ): Effect.Effect<boolean> {
    return Effect.sync(() => {
      this.confirms.push({ message, options });
      return this.confirmResponses.shift() ?? false;
    });
  }

  input(options: PromptInputOptions): Effect.Effect<string | undefined> {
    return Effect.sync(() => {
      this.inputs.push({ options });
      return this.inputResponses.shift();
    });
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

  openExternal(url: string): Effect.Effect<void, ExternalOpenFailed> {
    return Effect.sync(() => {
      this.externalUrls.push(url);
    });
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
