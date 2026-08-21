/**
 * Agent templates — the cross-host public surface of `src/agent/templates`.
 *
 * One curated barrel the hosts import instead of deep-reaching the template
 * modules by path: rendering an agent template string
 * (`renderAgentTemplateString`) — decoupling host code from the template
 * internals' file layout, per the module-level barrel pattern set by
 * `@agent/runtime` (#10011) and `@agent/followUp`. The R-b deep-import width
 * ratchet (`config/ratchets/host-agent-import-baseline.json`) records each
 * host's single `@agent/templates` specifier; the former
 * `@agent/templates/agentTemplateRenderer` deep import moved to this door so
 * the host stops pinning the renderer's file name.
 *
 * Internal template modules keep importing each other by direct path; nothing
 * inside `src/agent` imports this barrel, so it introduces no import cycle.
 */

export { renderAgentTemplateString } from './agentTemplateRenderer';
