/**
 * Agent core definition — the cross-host public surface of
 * `src/agent/core/definition`.
 *
 * One curated barrel the hosts (CLI, desktop, extension) import instead of
 * deep-reaching `AgentConfig.ts` by path. It exposes only the stable config
 * contract hosts name at their launch/resume seams — the parsed launch
 * configuration schema (`AgentConfigSchema`), its parsed output type
 * (`AgentConfig`), and the partial launch-time input type
 * (`AgentConfigPayload`) — decoupling host code from the
 * definition directory's internal file layout, per the module-level barrel
 * pattern set by `@agent/runtime` (#10011), `@agent/storage` (#10531), and
 * `@agent/followUp` (#10650). The R-b deep-import width ratchet
 * (`config/ratchets/host-agent-import-baseline.json`) records each host's
 * single `@agent/core/definition` specifier; the former
 * `@agent/core/definition/AgentConfig` deep imports collapsed to this door.
 *
 * Internal definition and agent modules keep importing each other by direct
 * path; nothing inside `src/agent` imports this barrel, so it introduces no
 * import cycle. The wider `AgentDataclass` schema surface is deliberately not
 * re-exported here: it is package-public schema surface assembled by
 * `packages/agent/src/schemas.ts`, not a cross-host deep import, and it stays
 * on its own narrow module.
 */

export {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from './AgentConfig';
