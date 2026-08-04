<script setup>
// Frameless illustration of the "TeXRA: View Profile" surface: a compact
// account header (email + access-level badge) over the Remote Agents table
// (Agent · What it does · Action). Mirrors the per-row table layout of
// ApiKeysHero (Provider/Status/Actions → Agent/Description/Action) and reuses
// the StatusPill vocabulary for the access badge. No VS Code window chrome —
// it is a single focused figure that flips with the docs theme via `.mockup`.
import MockupPanel from './MockupPanel.vue';
import StatusPill from './StatusPill.vue';

// Remote agent names + one-liners match Built-in Agents → Remote Agents.
const rows = [
  {
    name: 'search',
    desc: 'Literature discovery',
    state: 'use',
  },
  {
    name: 'orchestrator',
    desc: 'Multi-agent coordination',
    state: 'in-use',
  },
  {
    name: 'simplifier',
    desc: 'Code & writing simplification',
    state: 'use',
  },
];
</script>

<template>
  <MockupPanel
    title="TeXRA — View Profile"
    icon="user"
    caption="account · remote agents"
  >
    <!-- Account header: who you are + access level. -->
    <div class="rap-acct">
      <wa-icon class="rap-avatar" library="texra" name="circle-user"></wa-icon>
      <div class="rap-acct-id">
        <span class="rap-email">you@university.edu</span>
        <span class="rap-uid">user ID · usr_8f3c…21a</span>
      </div>
      <StatusPill variant="accent" icon="shield">Research Access</StatusPill>
    </div>

    <!-- Remote Agents table (Agent · What it does · Action). -->
    <table class="rap-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>What it does</th>
          <th class="ta-r">Action</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.name">
          <td>
            <div class="rap-agent">
              <wa-icon class="rap-cloud" library="texra" name="cloud"></wa-icon>
              <span class="rap-name">{{ row.name }}</span>
            </div>
          </td>
          <td>
            <span class="rap-desc">{{ row.desc }}</span>
          </td>
          <td>
            <div class="rap-action">
              <span v-if="row.state === 'use'" class="rap-use">Use</span>
              <StatusPill v-else variant="success" icon="circle-check"
                >In use</StatusPill
              >
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </MockupPanel>
</template>

<style scoped>
/* All tokens resolve from the `.mockup` scope MockupPanel establishes. */
.rap-acct {
  display: flex;
  align-items: center;
  gap: var(--mk-space-10);
  padding: var(--mk-space-8) var(--mk-space-10);
  background: var(--mk-bg-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius-lg);
  margin-bottom: var(--mk-space-12);
}
.rap-avatar {
  font-size: var(--mk-size-24);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.rap-acct-id {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.rap-email {
  font-size: var(--mk-fs-80);
  font-weight: 600;
  color: var(--wa-color-text-normal);
}
.rap-uid {
  font-size: var(--mk-fs-68);
  font-family: var(--vp-font-family-mono);
  color: var(--color-text-tertiary);
}

.rap-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--mk-fs-80);
}
.rap-table th {
  text-align: left;
  font-size: var(--mk-fs-66);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  padding: 0 var(--mk-space-8) var(--mk-space-6);
  border-bottom: 1px solid var(--color-border);
}
.rap-table th.ta-r {
  text-align: right;
}
.rap-table td {
  padding: var(--mk-space-7) var(--mk-space-8);
  border-bottom: 1px solid var(--mk-border);
  vertical-align: middle;
}
.rap-table tbody tr:last-child td {
  border-bottom: none;
}

.rap-agent {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
}
.rap-cloud {
  font-size: var(--mk-space-12);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.rap-name {
  font-family: var(--vp-font-family-mono);
  font-weight: 500;
  color: var(--wa-color-text-normal);
}
.rap-desc {
  color: var(--color-text-secondary);
}

.rap-action {
  display: flex;
  justify-content: flex-end;
}
.rap-use {
  display: inline-flex;
  align-items: center;
  font-size: var(--mk-fs-74);
  font-weight: 600;
  color: var(--brand);
  background: color-mix(in srgb, var(--mk-accent) 13%, transparent);
  border: 1px solid var(--mk-accent);
  border-radius: var(--mk-radius-pill);
  padding: 1px var(--mk-space-10);
  cursor: pointer;
}
</style>
