import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach } from 'vitest';

type TestElementInternals = {
  validity?: ValidityState;
  validationMessage?: string;
  willValidate?: boolean;
  form?: HTMLFormElement | null;
  setValidity?: (flags?: ValidityStateFlags) => void;
  setFormValue?: (value: unknown, state?: unknown) => void;
  checkValidity?: () => boolean;
  reportValidity?: () => boolean;
};

type TestDomWindow = JSDOM['window'] & {
  ElementInternals?: {
    prototype: TestElementInternals;
  };
};

const domGlobalKeys = [
  'window',
  'document',
  'Document',
  'customElements',
  'HTMLElement',
  'HTMLInputElement',
  'CustomEvent',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'ShadowRoot',
  'Node',
] as const;

const DEFAULT_VALIDITY = {
  badInput: false,
  customError: false,
  patternMismatch: false,
  rangeOverflow: false,
  rangeUnderflow: false,
  stepMismatch: false,
  tooLong: false,
  tooShort: false,
  typeMismatch: false,
  valid: true,
  valueMissing: false,
} satisfies ValidityState;

function installElementInternalsPolyfill(window: TestDomWindow): void {
  const ElementInternalsCtor = window.ElementInternals;
  if (!ElementInternalsCtor) {
    return;
  }

  const validityByInternals = new WeakMap<object, ValidityState>();
  const prototype = ElementInternalsCtor.prototype;

  if (!('validity' in prototype)) {
    Object.defineProperty(prototype, 'validity', {
      configurable: true,
      get() {
        return validityByInternals.get(this) ?? DEFAULT_VALIDITY;
      },
    });
  }

  if (!('validationMessage' in prototype)) {
    Object.defineProperty(prototype, 'validationMessage', {
      configurable: true,
      get() {
        return '';
      },
    });
  }

  if (!('willValidate' in prototype)) {
    Object.defineProperty(prototype, 'willValidate', {
      configurable: true,
      get() {
        return true;
      },
    });
  }

  if (!('form' in prototype)) {
    Object.defineProperty(prototype, 'form', {
      configurable: true,
      get() {
        return null;
      },
    });
  }

  if (!prototype.setValidity) {
    prototype.setValidity = function setValidity(
      this: object,
      flags?: ValidityStateFlags,
    ) {
      const invalid = Object.values(flags ?? {}).some(Boolean);
      validityByInternals.set(this, {
        ...DEFAULT_VALIDITY,
        ...(flags ?? {}),
        valid: !invalid,
      });
    };
  }

  if (!prototype.setFormValue) {
    prototype.setFormValue = () => {
      /* jsdom does not implement form-associated custom element state. */
    };
  }

  if (!prototype.checkValidity) {
    prototype.checkValidity = function checkValidity(this: object) {
      return (validityByInternals.get(this) ?? DEFAULT_VALIDITY).valid;
    };
  }

  if (!prototype.reportValidity) {
    prototype.reportValidity = prototype.checkValidity;
  }
}

/**
 * Install the browser globals Lit components need, import the component module,
 * and reset the document between tests.
 */
export function useLitComponentTestDom(
  importComponents: () => Promise<unknown>,
): void {
  let dom: JSDOM;
  const previousGlobals = new Map<
    (typeof domGlobalKeys)[number],
    { hadValue: boolean; value: unknown }
  >();

  beforeAll(async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://texra.local',
    });

    const replacements = {
      window: dom.window,
      document: dom.window.document,
      Document: dom.window.Document,
      customElements: dom.window.customElements,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      CustomEvent: dom.window.CustomEvent,
      Event: dom.window.Event,
      KeyboardEvent: dom.window.KeyboardEvent,
      MouseEvent: dom.window.MouseEvent,
      ShadowRoot: dom.window.ShadowRoot,
      Node: dom.window.Node,
    } satisfies Record<(typeof domGlobalKeys)[number], unknown>;

    for (const key of domGlobalKeys) {
      previousGlobals.set(key, {
        hadValue: Object.hasOwn(globalThis, key),
        value: globalThis[key as keyof typeof globalThis],
      });
      Object.defineProperty(globalThis, key, {
        configurable: true,
        writable: true,
        value: replacements[key],
      });
    }

    installElementInternalsPolyfill(dom.window);
    await importComponents();
  });

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterAll(() => {
    dom.window.close();
    for (const key of domGlobalKeys) {
      const previous = previousGlobals.get(key);
      if (previous?.hadValue) {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value: previous.value,
        });
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
}
