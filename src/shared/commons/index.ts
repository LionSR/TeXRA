/**
 * Commons bundle entry point for webviews.
 *
 * This module exports all shared dependencies as a UMD library (WebviewCommons)
 * that is loaded once and referenced by all webview bundles via externals.
 *
 * Includes:
 * - zod (schema validation)
 * - lit (web components framework)
 * - @lit/context (context API)
 * - Shared webview utilities and base classes
 */

// Third-party: Zod
export * as z from 'zod';
export { z as zod } from 'zod';

// Third-party: Lit core
export {
  LitElement,
  html,
  css,
  svg,
  nothing,
  noChange,
  unsafeCSS,
  type CSSResult,
  type CSSResultGroup,
  type PropertyValues,
  type TemplateResult,
} from 'lit';

// Third-party: Lit decorators
export {
  customElement,
  property,
  state,
  query,
  queryAll,
  queryAssignedElements,
  eventOptions,
} from 'lit/decorators.js';

// Third-party: Lit directives
export { unsafeHTML } from 'lit/directives/unsafe-html.js';
export { classMap } from 'lit/directives/class-map.js';
export { styleMap } from 'lit/directives/style-map.js';
export { ifDefined } from 'lit/directives/if-defined.js';
export { repeat } from 'lit/directives/repeat.js';
export { guard } from 'lit/directives/guard.js';
export { cache } from 'lit/directives/cache.js';
export { keyed } from 'lit/directives/keyed.js';
export { when } from 'lit/directives/when.js';
export { choose } from 'lit/directives/choose.js';
export { map } from 'lit/directives/map.js';
export { join } from 'lit/directives/join.js';
export { range } from 'lit/directives/range.js';
export { live } from 'lit/directives/live.js';
export { ref, createRef, type Ref } from 'lit/directives/ref.js';

// Third-party: @lit/context
export {
  createContext,
  consume,
  provide,
  ContextProvider,
  ContextConsumer,
  type Context,
} from '@lit/context';

// Shared: Base webview app
export { BaseWebviewApp } from '@shared/BaseWebviewApp';

// Shared: VS Code API
export { vscode, postMessage, type VSCodeApi } from '@shared/vscode';

// Shared: Schemas (re-export everything)
export * from '@shared/schemas';

// Shared: Styles
export * from '@shared/styles';

// Shared: State management
export * from '@shared/state';

// Shared: Handlers
export {
  handleCommonMessage,
  type CommonMessageContext,
} from '@shared/handlers/commonMessageHandlers';

// Shared: Contexts
export { themeContext } from '@shared/contexts/themeContext';

// Shared: Controllers
export * from '@shared/controllers';

// Shared: Utils
export * from '@shared/utils/events';
export * from '@shared/utils/uiConstants';
export * from '@shared/utils/path';
export * from '@shared/utils/string';
export * from '@shared/utils/clipboard';
export * from '@shared/utils/dispatcher';
export * from '@shared/utils/dom';
export * from '@shared/utils/icons';
export * from '@shared/utils/selectTemplates';
export * from '@shared/utils/textarea';

// Shared: Streams
export * from '@shared/streams/streamSort';
export * from '@shared/streams/runSelection';

// Shared: Files
export * from '@shared/files/pastedImageConstants';

// Shared: Highlighting (default export requires explicit re-export)
export { default as hljs } from '@shared/highlighting/hljs';
