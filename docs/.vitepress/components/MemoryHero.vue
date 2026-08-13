<script setup>
// Memory product slice: the Dashboard's Memory tab. Mirrors the real layout
// from packages/extension/src/settingsView/frontend/components/memory/ —
// reminder banner, "Enable memory for chat agents" switch, then a list of
// memory items with pinned/size/lines/updated/by metadata and a collapsible
// "Contents" preview. Tab order, icons, and `by <agent>` attributions match
// SettingsApp.ts / SETTINGS_TAB_ORDER and the real tool-use agent roster.
import { ref } from 'vue';
import MockupFrame from './MockupFrame.vue';
import MockSwitch from './MockSwitch.vue';

const enabled = ref(true);
const expanded = ref('pinned');

function toggle(id) {
  expanded.value = expanded.value === id ? null : id;
}
</script>

<template>
  <MockupFrame title="Dashboard — texra-paper">
    <!-- Settings tab strip. Tab order, panel names, and icons mirror
         SettingsApp.ts (Memory · History · Models · Agents · Multi-Agent ·
         Tools · Integrations · Git · LaTeX · Goal). The real UI lays them
         out horizontally above the content; this hero stacks them vertically
         only because ten tabs do not fit horizontally at mockup width. -->
    <aside class="board dash-nav">
      <nav class="dash-tabs">
        <span class="dt dt-on"
          ><wa-icon library="texra" name="database"></wa-icon> Memory</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="clock-rotate-left"></wa-icon>
          History</span
        >
        <span class="dt"
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
          ><wa-icon library="texra" name="compass"></wa-icon> Goal</span
        >
      </nav>
    </aside>

    <!-- Memory tab content -->
    <div class="mem-pane">
      <!-- Reminder banner -->
      <div class="reminder">
        <wa-icon class="reminder-ic" library="texra" name="info"></wa-icon>
        <div class="reminder-body">
          <div class="reminder-title">Memory notes</div>
          <div class="reminder-desc">
            The AI assistant can save notes here to remember important
            information across conversations. These notes help the assistant
            provide more contextual and personalized help.
          </div>
          <div class="reminder-acts">
            <button type="button" class="r-btn">
              <wa-icon library="texra" name="rotate-right"></wa-icon>
              Refresh
            </button>
            <button type="button" class="r-btn">
              <wa-icon library="texra" name="folder-open"></wa-icon>
              Open Folder
            </button>
          </div>
        </div>
      </div>

      <!-- Memory toggle (mirrors MemoryToggle), now a bridged wa-switch. -->
      <div class="mem-toggle">
        <MockSwitch v-model="enabled" label="Enable memory for chat agents" />
      </div>

      <!-- Memory list (mirrors MemoryList → MemoryItem). `by <agent>` uses
           tool-use agents (research, review, chat) — workflow agents like
           polish/correct don't run the memory tool. -->
      <div class="mem-list">
        <!-- Item 1: pinned, expanded with markdown preview -->
        <div class="mem-item pinned">
          <div class="mem-head">
            <div class="mem-path">/memories/project-conventions.md</div>
            <div class="mem-acts">
              <button
                type="button"
                class="m-act m-act-on"
                title="Unpin this memory"
              >
                <wa-icon library="texra" name="thumbtack-slash"></wa-icon>
              </button>
              <button type="button" class="m-act" title="Open in editor">
                <wa-icon library="texra" name="file-export"></wa-icon>
              </button>
              <button type="button" class="m-act" title="Delete this memory">
                <wa-icon library="texra" name="trash"></wa-icon>
              </button>
            </div>
          </div>
          <div class="mem-meta">
            <span>Pinned</span>
            <span class="meta-dot">·</span>
            <span>1.2 KB</span>
            <span class="meta-dot">·</span>
            <span>34 lines</span>
            <span class="meta-dot">·</span>
            <span>Updated 5m ago</span>
            <span class="meta-dot">·</span>
            <span>by research</span>
          </div>
          <button
            type="button"
            class="mem-coll"
            :class="{ open: expanded === 'pinned' }"
            @click="toggle('pinned')"
          >
            <wa-icon
              class="chev"
              library="texra"
              :name="expanded === 'pinned' ? 'chevron-down' : 'chevron-right'"
            ></wa-icon>
            Contents
          </button>
          <div v-if="expanded === 'pinned'" class="mem-preview">
            <div class="md-h">Project conventions</div>
            <ul class="md-ul">
              <li>
                Equations use <code class="md-code">\eqref</code>, not
                <code class="md-code">\ref</code>.
              </li>
              <li>
                Section labels follow
                <code class="md-code">sec:short-name</code>.
              </li>
              <li>
                Cite with <code class="md-code">\citep</code> inside parentheses
                and <code class="md-code">\citet</code> in running prose.
              </li>
              <li>
                The bibliography lives in
                <code class="md-code">references.bib</code>.
              </li>
            </ul>
          </div>
        </div>

        <!-- Item 2: collapsed -->
        <div class="mem-item">
          <div class="mem-head">
            <div class="mem-path">/memories/notation.md</div>
            <div class="mem-acts">
              <button
                type="button"
                class="m-act"
                title="Pin as core long-term memory"
              >
                <wa-icon library="texra" name="thumbtack"></wa-icon>
              </button>
              <button type="button" class="m-act" title="Open in editor">
                <wa-icon library="texra" name="file-export"></wa-icon>
              </button>
              <button type="button" class="m-act" title="Delete this memory">
                <wa-icon library="texra" name="trash"></wa-icon>
              </button>
            </div>
          </div>
          <div class="mem-meta">
            <span>624 B</span>
            <span class="meta-dot">·</span>
            <span>18 lines</span>
            <span class="meta-dot">·</span>
            <span>Updated 2h ago</span>
            <span class="meta-dot">·</span>
            <span>by review</span>
          </div>
          <button
            type="button"
            class="mem-coll"
            :class="{ open: expanded === 'notation' }"
            @click="toggle('notation')"
          >
            <wa-icon
              class="chev"
              library="texra"
              :name="expanded === 'notation' ? 'chevron-down' : 'chevron-right'"
            ></wa-icon>
            Contents
          </button>
          <div v-if="expanded === 'notation'" class="mem-preview">
            <ul class="md-ul">
              <li>
                Use <code class="md-code">\lambda_2</code> for the spectral gap.
              </li>
              <li>
                Vectors bold lowercase: <code class="md-code">\mathbf{x}</code>.
              </li>
            </ul>
          </div>
        </div>

        <!-- Item 3: collapsed -->
        <div class="mem-item">
          <div class="mem-head">
            <div class="mem-path">/memories/figures.md</div>
            <div class="mem-acts">
              <button
                type="button"
                class="m-act"
                title="Pin as core long-term memory"
              >
                <wa-icon library="texra" name="thumbtack"></wa-icon>
              </button>
              <button type="button" class="m-act" title="Open in editor">
                <wa-icon library="texra" name="file-export"></wa-icon>
              </button>
              <button type="button" class="m-act" title="Delete this memory">
                <wa-icon library="texra" name="trash"></wa-icon>
              </button>
            </div>
          </div>
          <div class="mem-meta">
            <span>312 B</span>
            <span class="meta-dot">·</span>
            <span>9 lines</span>
            <span class="meta-dot">·</span>
            <span>Updated yesterday</span>
            <span class="meta-dot">·</span>
            <span>by chat</span>
          </div>
          <button
            type="button"
            class="mem-coll"
            :class="{ open: expanded === 'figures' }"
            @click="toggle('figures')"
          >
            <wa-icon
              class="chev"
              library="texra"
              :name="expanded === 'figures' ? 'chevron-down' : 'chevron-right'"
            ></wa-icon>
            Contents
          </button>
          <div v-if="expanded === 'figures'" class="mem-preview">
            <ul class="md-ul">
              <li>
                Figures stored as PDF under
                <code class="md-code">figures/</code>.
              </li>
              <li>Always include a TikZ source alongside each rendered PDF.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </MockupFrame>
</template>

<style scoped>
/* Dashboard chrome (.dash-nav/.dash-tabs/.dt + the toggle .switch) lives in
   mockup.css, shared with ApiKeysHero. Only this tab's body is unique here. */

/* Memory tab body */
.mem-pane {
  flex: 1;
  min-width: 0;
  background: var(--mk-bg);
  padding: var(--mk-space-14) var(--mk-space-16);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-12);
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

/* Reminder banner (mirrors .settings-reminder) */
.reminder {
  display: flex;
  gap: var(--mk-space-10);
  padding: var(--mk-space-10) var(--mk-space-12);
  background: color-mix(in srgb, var(--mk-syn-fn) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--mk-syn-fn) 18%, transparent);
  border-radius: var(--mk-radius-lg);
}
.reminder-ic {
  color: var(--wa-color-icon-info);
  font-size: var(--mk-space-14);
  margin-top: var(--mk-space-2);
  flex-shrink: 0;
}
.reminder-body {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
  min-width: 0;
}
.reminder-title {
  font-size: var(--mk-fs-78);
  font-weight: 600;
  color: var(--wa-color-text-normal);
}
.reminder-desc {
  font-size: var(--mk-fs-74);
  color: var(--color-text-secondary);
  line-height: 1.45;
}
.reminder-acts {
  display: flex;
  gap: var(--mk-space-8);
  margin-top: var(--mk-space-6);
}
.r-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-70);
  color: var(--wa-color-text-normal);
  background: var(--mk-bg-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius);
  padding: var(--mk-space-4) var(--mk-space-9);
  cursor: pointer;
}
.r-btn:hover {
  background: var(--mk-border-soft);
}
.r-btn wa-icon {
  font-size: var(--mk-space-11);
  color: var(--color-text-secondary);
}

/* Toggle switch layout (the .switch control itself is shared via mockup.css) */
.mem-toggle {
  display: flex;
  align-items: center;
  gap: var(--mk-space-10);
  padding: var(--mk-space-6) var(--mk-space-2);
}

/* Memory list */
.mem-list {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
}
.mem-item {
  background: var(--mk-bg-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-10) var(--mk-space-12);
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
}
.mem-item.pinned {
  border-left: 2px solid var(--color-text-link);
  padding-left: calc(var(--mk-space-12) - 1px);
}
.mem-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-8);
}
.mem-path {
  flex: 1;
  min-width: 0;
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-78);
  font-weight: 500;
  color: var(--color-text-link);
  word-break: break-all;
}
.mem-acts {
  display: flex;
  gap: var(--mk-space-2);
  flex-shrink: 0;
}
.m-act {
  background: transparent;
  border: none;
  width: var(--mk-space-22);
  height: var(--mk-space-22);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--mk-radius-sm);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.m-act wa-icon {
  font-size: var(--mk-space-12);
}
.m-act:hover {
  background: var(--mk-hover-bg);
  color: var(--wa-color-text-normal);
}
.m-act-on {
  color: var(--color-text-link);
}

/* Meta strip (Pinned · size · lines · updated · by <agent>) */
.mem-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--mk-space-4);
  font-size: var(--mk-fs-70);
  color: var(--color-text-secondary);
}
.meta-dot {
  color: var(--color-text-tertiary);
}

/* Collapsible Contents header */
.mem-coll {
  margin-top: var(--mk-space-4);
  background: transparent;
  border: none;
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  padding: var(--mk-space-2) 0;
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
  cursor: pointer;
  align-self: flex-start;
}
.mem-coll:hover {
  color: var(--wa-color-text-normal);
}
.mem-coll wa-icon {
  font-size: var(--mk-space-11);
}

/* Inline markdown preview */
.mem-preview {
  margin-top: var(--mk-space-4);
  padding: var(--mk-space-8) var(--mk-space-10);
  background: var(--mk-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius);
  font-size: var(--mk-fs-76);
  line-height: 1.45;
  color: var(--wa-color-text-normal);
}
.md-h {
  font-weight: 600;
  margin-bottom: var(--mk-space-4);
}
.md-ul {
  margin: 0;
  padding-left: var(--mk-space-18);
}
.md-ul li {
  margin: var(--mk-space-2) 0;
}
.md-code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-72);
  background: var(--mk-bg-raised);
  padding: 1px var(--mk-space-4);
  border-radius: var(--mk-radius-sm);
  color: var(--mk-accent);
}
</style>
