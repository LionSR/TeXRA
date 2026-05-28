<script setup>
// Memory product slice: the Dashboard's Memory tab. Mirrors the real layout
// from packages/extension/src/settingsView/frontend/components/memory/ —
// reminder banner, "Enable memory for chat agents" switch, then a list of
// memory items with pinned/size/lines/updated/by metadata and a collapsible
// "Contents" preview. The first item is pinned and expanded so the markdown
// preview is visible; the others stay collapsed to keep the mockup compact.
import { ref } from 'vue';
import MockupFrame from './MockupFrame.vue';

const enabled = ref(true);
const expanded = ref('pinned');

function toggle(id) {
  expanded.value = expanded.value === id ? null : id;
}
</script>

<template>
  <MockupFrame title="Dashboard — texra-paper">
    <!-- Dashboard tab strip (mirrors SettingsTabBar) -->
    <aside class="dash-nav">
      <div class="dash-title">
        <wa-icon library="texra" name="settings-gear"></wa-icon>
        <span>Dashboard</span>
      </div>
      <nav class="dash-tabs">
        <span class="dt"
          ><wa-icon library="texra" name="history"></wa-icon> History</span
        >
        <span class="dt dt-on"
          ><wa-icon library="texra" name="database"></wa-icon> Memory</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="robot"></wa-icon> Models</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="account"></wa-icon> Agents</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="organization"></wa-icon> Multi-Agent</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="tools"></wa-icon> Tools</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="source-control"></wa-icon> Git</span
        >
        <span class="dt"
          ><wa-icon library="texra" name="file-code"></wa-icon> LaTeX</span
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
              <wa-icon library="texra" name="refresh"></wa-icon>
              Refresh
            </button>
            <button type="button" class="r-btn">
              <wa-icon library="texra" name="folder-opened"></wa-icon>
              Open Folder
            </button>
          </div>
        </div>
      </div>

      <!-- Memory toggle (mirrors MemoryToggle) -->
      <div class="mem-toggle">
        <span
          class="switch"
          :class="{ on: enabled }"
          role="switch"
          :aria-checked="enabled"
          @click="enabled = !enabled"
        >
          <span class="switch-knob"></span>
        </span>
        <span class="switch-label">Enable memory for chat agents</span>
      </div>

      <!-- Memory list (mirrors MemoryList → MemoryItem) -->
      <div class="mem-list">
        <!-- Item 1: pinned, expanded with markdown preview -->
        <div class="mem-item pinned">
          <div class="mem-head">
            <div class="mem-path">/memories/project-conventions.md</div>
            <div class="mem-acts">
              <button class="m-act m-act-on" title="Unpin">
                <wa-icon library="texra" name="thumbtack-slash"></wa-icon>
              </button>
              <button class="m-act" title="Open in editor">
                <wa-icon library="texra" name="file-export"></wa-icon>
              </button>
              <button class="m-act" title="Delete this memory">
                <wa-icon library="texra" name="trash"></wa-icon>
              </button>
            </div>
          </div>
          <div class="mem-meta">
            <span class="meta-pill meta-pin">Pinned</span>
            <span class="meta-dot">·</span>
            <span>1.2 KB</span>
            <span class="meta-dot">·</span>
            <span>34 lines</span>
            <span class="meta-dot">·</span>
            <span>Updated 5m ago</span>
            <span class="meta-dot">·</span>
            <span>by polish</span>
          </div>
          <button
            class="mem-coll"
            :class="{ open: expanded === 'pinned' }"
            @click="toggle('pinned')"
          >
            <wa-icon
              class="chev"
              library="texra"
              :name="
                expanded === 'pinned' ? 'chevron-down' : 'chevron-right'
              "
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
              <li>The bibliography lives in <code class="md-code">references.bib</code>.</li>
            </ul>
          </div>
        </div>

        <!-- Item 2: collapsed -->
        <div class="mem-item">
          <div class="mem-head">
            <div class="mem-path">/memories/notation.md</div>
            <div class="mem-acts">
              <button class="m-act" title="Pin">
                <wa-icon library="texra" name="thumbtack"></wa-icon>
              </button>
              <button class="m-act" title="Open in editor">
                <wa-icon library="texra" name="file-export"></wa-icon>
              </button>
              <button class="m-act" title="Delete this memory">
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
            <span>by correct</span>
          </div>
          <button
            class="mem-coll"
            :class="{ open: expanded === 'notation' }"
            @click="toggle('notation')"
          >
            <wa-icon
              class="chev"
              library="texra"
              :name="
                expanded === 'notation' ? 'chevron-down' : 'chevron-right'
              "
            ></wa-icon>
            Contents
          </button>
          <div v-if="expanded === 'notation'" class="mem-preview">
            <ul class="md-ul">
              <li>Use <code class="md-code">\lambda_2</code> for the spectral gap.</li>
              <li>Vectors bold lowercase: <code class="md-code">\mathbf{x}</code>.</li>
            </ul>
          </div>
        </div>

        <!-- Item 3: collapsed -->
        <div class="mem-item">
          <div class="mem-head">
            <div class="mem-path">/memories/figures.md</div>
            <div class="mem-acts">
              <button class="m-act" title="Pin">
                <wa-icon library="texra" name="thumbtack"></wa-icon>
              </button>
              <button class="m-act" title="Open in editor">
                <wa-icon library="texra" name="file-export"></wa-icon>
              </button>
              <button class="m-act" title="Delete this memory">
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
            <span>by figure</span>
          </div>
          <button
            class="mem-coll"
            :class="{ open: expanded === 'figures' }"
            @click="toggle('figures')"
          >
            <wa-icon
              class="chev"
              library="texra"
              :name="
                expanded === 'figures' ? 'chevron-down' : 'chevron-right'
              "
            ></wa-icon>
            Contents
          </button>
          <div v-if="expanded === 'figures'" class="mem-preview">
            <ul class="md-ul">
              <li>Figures stored as PDF under <code class="md-code">figures/</code>.</li>
              <li>Always include a TikZ source alongside each rendered PDF.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </MockupFrame>
</template>

<style scoped>
/* Dashboard tab nav on the left (the real settings view stacks tabs across the
   top, but a vertical strip works better at mockup widths). */
.dash-nav {
  width: 168px;
  flex-shrink: 0;
  background: #1e1e1e;
  border-right: 1px solid #000;
  display: flex;
  flex-direction: column;
  padding: 12px 0;
}
.dash-title {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px 12px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--wa-color-text-normal);
  border-bottom: 1px solid var(--color-border);
}
.dash-title wa-icon {
  color: var(--brand);
  font-size: 14px;
}
.dash-tabs {
  display: flex;
  flex-direction: column;
  padding-top: 8px;
}
.dt {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  font-size: 0.76rem;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-left: 2px solid transparent;
}
.dt wa-icon {
  font-size: 12px;
}
.dt:hover {
  color: var(--wa-color-text-normal);
  background: rgba(255, 255, 255, 0.03);
}
.dt-on {
  color: #fff;
  font-weight: 600;
  background: rgba(200, 155, 224, 0.08);
  border-left-color: var(--brand);
}

/* Memory tab body */
.mem-pane {
  flex: 1;
  min-width: 0;
  background: #1e1e1e;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

/* Reminder banner (mirrors .settings-reminder) */
.reminder {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(117, 190, 255, 0.06);
  border: 1px solid rgba(117, 190, 255, 0.18);
  border-radius: 6px;
}
.reminder-ic {
  color: var(--wa-color-icon-info);
  font-size: 14px;
  margin-top: 2px;
  flex-shrink: 0;
}
.reminder-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.reminder-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--wa-color-text-normal);
}
.reminder-desc {
  font-size: 0.74rem;
  color: var(--color-text-secondary);
  line-height: 1.45;
}
.reminder-acts {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.r-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.7rem;
  color: var(--wa-color-text-normal);
  background: #2c2c2c;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 4px 9px;
  cursor: pointer;
}
.r-btn:hover {
  background: #3a3a3a;
}
.r-btn wa-icon {
  font-size: 11px;
  color: var(--color-text-secondary);
}

/* Toggle switch */
.mem-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 2px;
}
.switch {
  display: inline-flex;
  align-items: center;
  width: 32px;
  height: 18px;
  background: #444;
  border-radius: 10px;
  position: relative;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}
.switch.on {
  background: var(--brand);
}
.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.15s;
}
.switch.on .switch-knob {
  transform: translateX(14px);
}
.switch-label {
  font-size: 0.78rem;
  color: var(--wa-color-text-normal);
}

/* Memory list */
.mem-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mem-item {
  background: #252526;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mem-item.pinned {
  border-left: 2px solid var(--color-text-link);
  padding-left: calc(12px - 1px);
}
.mem-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mem-path {
  flex: 1;
  min-width: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--color-text-link);
  word-break: break-all;
}
.mem-acts {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.m-act {
  background: transparent;
  border: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.m-act wa-icon {
  font-size: 12px;
}
.m-act:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--wa-color-text-normal);
}
.m-act-on {
  color: var(--color-text-link);
}

/* Meta strip (Pinned · size · lines · updated · by) */
.mem-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 0.7rem;
  color: var(--color-text-secondary);
}
.meta-dot {
  color: var(--color-text-tertiary);
}
.meta-pill {
  background: rgba(77, 170, 252, 0.12);
  color: var(--color-text-link);
  font-size: 0.64rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 3px;
}

/* Collapsible Contents header */
.mem-coll {
  margin-top: 4px;
  background: transparent;
  border: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 0;
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  cursor: pointer;
  align-self: flex-start;
}
.mem-coll:hover {
  color: var(--wa-color-text-normal);
}
.mem-coll wa-icon {
  font-size: 11px;
}

/* Inline markdown preview */
.mem-preview {
  margin-top: 4px;
  padding: 8px 10px;
  background: #1e1e1e;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 0.76rem;
  line-height: 1.45;
  color: var(--wa-color-text-normal);
}
.md-h {
  font-weight: 600;
  margin-bottom: 4px;
}
.md-ul {
  margin: 0;
  padding-left: 18px;
}
.md-ul li {
  margin: 2px 0;
}
.md-code {
  font-family: var(--vp-font-family-mono);
  font-size: 0.72rem;
  background: #2a2a2a;
  padding: 1px 4px;
  border-radius: 3px;
  color: #d7baee;
}

@media (max-width: 820px) {
  .dash-nav {
    width: auto;
    flex-direction: row;
    border-right: none;
    border-bottom: 1px solid #000;
    padding: 0;
    overflow-x: auto;
  }
  .dash-title {
    display: none;
  }
  .dash-tabs {
    flex-direction: row;
    padding: 0;
  }
  .dt {
    border-left: none;
    border-bottom: 2px solid transparent;
    padding: 8px 12px;
    white-space: nowrap;
  }
  .dt-on {
    border-left-color: transparent;
    border-bottom-color: var(--brand);
  }
}
</style>
