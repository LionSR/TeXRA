<script setup>
// API-keys product slice: the Settings Dashboard → Models tab → "API
// Configuration" table. Mirrors ProviderKeyList.ts — a per-provider table
// (Provider · Status · Actions) with a global streaming toggle above it. Each
// row exposes Set (key), Get (open key page), and Remove (only when a key is
// stored); status is Set / Env / Not set. Tab order mirrors SettingsApp.ts.
import { ref } from 'vue';
import MockupFrame from './MockupFrame.vue';

const streaming = ref(true);

const rows = [
  { name: 'Anthropic', status: 'set', label: 'Key set' },
  { name: 'OpenAI', status: 'set', label: 'Key set' },
  { name: 'Google', status: 'env', label: 'Env' },
  { name: 'xAI', status: 'not-set', label: 'Not set' },
  { name: 'DeepSeek', status: 'not-set', label: 'Not set' },
];
</script>

<template>
  <MockupFrame title="Dashboard — texra-paper">
    <aside class="board dash-nav">
      <nav class="dash-tabs">
        <span class="dt"
          ><wa-icon library="texra" name="database"></wa-icon> Memory</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="clock-rotate-left"></wa-icon>
          History</span
        >
        <span class="dt dt-on"
          ><wa-icon library="texra" name="server"></wa-icon> Models</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="robot"></wa-icon> Agents</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="users"></wa-icon> Multi-Agent</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="screwdriver-wrench"></wa-icon>
          Tools</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="robot"></wa-icon> Integrations</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="code-branch"></wa-icon> Git</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="file-code"></wa-icon> LaTeX</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="compass"></wa-icon> Odyssey</span
        >
      </nav>
    </aside>

    <!-- Models tab → API Configuration -->
    <div class="api-pane">
      <h2 class="api-h2">API Configuration</h2>
      <p class="api-desc">
        Chat subscriptions (ChatGPT Plus, Claude Pro, etc.) do not include API
        access — you need a key from the provider's developer platform.
      </p>

      <!-- Global streaming default (mirrors renderGlobalStreamingToggle). -->
      <div class="api-stream">
        <button
          type="button"
          class="switch"
          :class="{ on: streaming }"
          role="switch"
          :aria-checked="streaming"
          @click="streaming = !streaming"
        >
          <span class="switch-knob"></span>
        </button>
        <span class="switch-label">Enable streaming</span>
        <span class="api-stream-desc">Global default for all providers</span>
      </div>

      <table class="api-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Status</th>
            <th class="ta-r">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name">
            <td>
              <div class="prov">
                <wa-icon
                  class="prov-chev"
                  library="texra"
                  name="chevron-right"
                ></wa-icon>
                <span class="prov-name">{{ row.name }}</span>
              </div>
            </td>
            <td>
              <span class="status" :class="`status--${row.status}`">
                <wa-icon
                  v-if="row.status === 'set'"
                  library="texra"
                  name="circle-check"
                ></wa-icon>
                {{ row.label }}
              </span>
            </td>
            <td>
              <div class="row-acts">
                <span class="key-btn" title="Set API key"
                  ><wa-icon library="texra" name="key"></wa-icon
                ></span>
                <span class="key-btn" title="Get API key from provider"
                  ><wa-icon
                    library="texra"
                    name="arrow-up-right-from-square"
                  ></wa-icon
                ></span>
                <span
                  v-if="row.status === 'set'"
                  class="key-btn key-btn--rm"
                  title="Remove key"
                  ><wa-icon library="texra" name="trash"></wa-icon
                ></span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </MockupFrame>
</template>

<style scoped>
/* Dashboard chrome (.dash-nav/.dash-tabs/.dt + the .switch toggle) is shared
   via mockup.css; only the API Configuration table body is unique here. */
.api-pane {
  flex: 1;
  min-width: 0;
  background: var(--mk-bg);
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}
.api-h2 {
  margin: 0;
  padding: 0;
  border: none;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--wa-color-text-normal);
}
.api-desc {
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--color-text-secondary);
}

.api-stream {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--mk-bg-soft);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}
.api-stream-desc {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
}

.api-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.api-table th {
  text-align: left;
  font-size: 0.66rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  padding: 0 8px 6px;
  border-bottom: 1px solid var(--color-border);
}
.api-table th.ta-r {
  text-align: right;
}
.api-table td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--mk-border);
}

.prov {
  display: flex;
  align-items: center;
  gap: 7px;
}
.prov-chev {
  font-size: 11px;
  color: var(--color-text-tertiary);
}
.prov-name {
  color: var(--wa-color-text-normal);
  font-weight: 500;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.74rem;
}
.status wa-icon {
  font-size: 12px;
}
.status--set {
  color: var(--color-success);
}
.status--env {
  color: var(--wa-color-icon-info);
}
.status--not-set {
  color: var(--color-text-tertiary);
}

.row-acts {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}
.key-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.key-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--wa-color-text-normal);
}
.key-btn--rm:hover {
  color: var(--color-error);
}
</style>
