// Third-party imports
import { Effect } from 'effect';

// Local imports - hosts
import type {
  ConfirmQuestion,
  Dialogs,
  ExternalOpener,
  HostFailed,
  InputField,
  NoticeLevel,
} from '@texra/hosts/uiHosts';

interface FakeUIHostsOptions {
  confirmResponses?: readonly boolean[];
  inputResponses?: readonly (string | undefined)[];
}

/** Records what it was asked and answers from the queued responses: a
 *  confirmation with none left is `false`, an input `undefined`. */
class FakeDialogs implements Dialogs {
  readonly notices: { level: NoticeLevel; message: string }[] = [];

  readonly confirms: ConfirmQuestion[] = [];

  readonly inputs: InputField[] = [];

  private readonly confirmResponses: boolean[];

  private readonly inputResponses: (string | undefined)[];

  constructor(options: FakeUIHostsOptions = {}) {
    this.confirmResponses = [...(options.confirmResponses ?? [])];
    this.inputResponses = [...(options.inputResponses ?? [])];
  }

  notify(level: NoticeLevel, message: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.notices.push({ level, message });
    });
  }

  confirm(question: ConfirmQuestion): Effect.Effect<boolean> {
    return Effect.sync(() => {
      this.confirms.push(question);
      return this.confirmResponses.shift() ?? false;
    });
  }

  input(field: InputField): Effect.Effect<string | undefined> {
    return Effect.sync(() => {
      this.inputs.push(field);
      return this.inputResponses.shift();
    });
  }
}

class FakeExternalOpener implements ExternalOpener {
  readonly externalUrls: string[] = [];

  openExternal(url: string): Effect.Effect<void, HostFailed> {
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
interface FakeUIHosts {
  readonly dialogs: FakeDialogs;
  readonly externalOpener: FakeExternalOpener;
}

export function createFakeUIHosts(
  options: FakeUIHostsOptions = {},
): FakeUIHosts {
  return {
    dialogs: new FakeDialogs(options),
    externalOpener: new FakeExternalOpener(),
  };
}
