/**
 * The host's code editor, where it has one with extensions and settings
 * TeXRA recommends (VS Code). A host without one serves none: its absence is
 * the capability missing, so no reader takes a flag beside it.
 */
import { Context, type Effect } from 'effect';

import type { LatexRecommendedSettingField } from '@texra/shared/constants/latexToolchain';

/** The editor's extensions and the LaTeX settings TeXRA recommends in it. */
export interface EditorIntegrationShape {
  /** Whether extension `extensionId` is installed; a registry read. */
  installed(extensionId: string): boolean;
  /** Install `extensionId` from the editor's marketplace. */
  install(extensionId: string): Effect.Effect<void, Error>;
  /** Which recommended settings hold their recommended value. */
  recommendedSettings(): {
    readonly [Field in LatexRecommendedSettingField]: boolean;
  };
  /** Write one recommended setting (every one without `field`), or remove
   *  it again with `reset`. */
  applyRecommended(
    field: LatexRecommendedSettingField | undefined,
    reset: boolean,
  ): Effect.Effect<void, Error>;
}

/** The editor as a service, which the setup plugin's process layer serves
 *  from what the host passes; `undefined` on a host without one. */
export const EditorIntegration = Context.Reference<
  EditorIntegrationShape | undefined
>('@texra-ai/texra/hosts/EditorIntegration', { defaultValue: () => undefined });

/** The host capability a tool that needs the editor's extensions names. */
export const EDITOR_EXTENSIONS_CAPABILITY = 'extensions';
