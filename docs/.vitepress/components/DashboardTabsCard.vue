<script setup>
// Frameless Dashboard navigation rail. Mirrors the ten Dashboard tabs from
// SettingsApp.ts / SETTINGS_TAB_ORDER (Memory · History · Models · Agents ·
// Multi-Agent · Tools · Integrations · Git · LaTeX · Goal), each with its
// real wa-icon and a one-line role label. Reuses the .dash-tabs/.dt/.dt-on
// accent-bar idea from MemoryHero/ApiKeysHero, extended with a sub-line — no
// VS Code window chrome. The root carries `.mockup`, so it inherits the
// --mk-* token block and flips with the docs light/dark theme.
const tabs = [
  {
    name: 'Memory',
    icon: 'database',
    role: 'See what tool-use agents remembered; pin or delete entries',
  },
  {
    name: 'History',
    icon: 'clock-rotate-left',
    role: 'Search and browse past runs',
  },
  {
    name: 'Models',
    icon: 'server',
    role: 'Pick which models show in your dropdown; set API keys per provider',
    on: true,
  },
  {
    name: 'Agents',
    icon: 'robot',
    role: 'Toggle agents on or off for this workspace',
  },
  {
    name: 'Multi-Agent',
    icon: 'users',
    role: 'Configure multi-agent orchestration and presets',
  },
  {
    name: 'Tools',
    icon: 'screwdriver-wrench',
    role: 'Manage tool-use capabilities and approval settings',
  },
  {
    name: 'Integrations',
    icon: 'robot',
    role: 'Set up OpenAI Codex / Claude Code hand-offs',
  },
  {
    name: 'Git',
    icon: 'code-branch',
    role: 'GitHub token for github_subscription; commit authorship',
  },
  {
    name: 'LaTeX',
    icon: 'file-code',
    role: 'Configure formatting, diff, and TikZ settings',
  },
  {
    name: 'Goal',
    icon: 'compass',
    role: 'Watch active and past autonomous Goals',
  },
];
</script>

<template>
  <div class="mockup dtc" role="group" aria-label="TeXRA Dashboard tabs">
    <div class="dtc-head">
      <wa-icon class="dtc-head-ic" library="texra" name="gear"></wa-icon>
      <span class="dtc-head-title">Dashboard</span>
      <span class="dtc-head-cap">texra-paper</span>
    </div>
    <nav class="dtc-rail">
      <span
        v-for="tab in tabs"
        :key="tab.name"
        class="dtc-tab"
        :class="{ 'dtc-on': tab.on }"
      >
        <wa-icon class="dtc-ic" library="texra" :name="tab.icon"></wa-icon>
        <span class="dtc-text">
          <span class="dtc-name">{{ tab.name }}</span>
          <span class="dtc-role">{{ tab.role }}</span>
        </span>
      </span>
    </nav>
  </div>
</template>

<style scoped>
/* All tokens resolve from `.mockup` (theme/mockup.css). No raw hex / px. */
.dtc {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) auto;
  max-width: var(--mk-size-470);
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

.dtc-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-8) var(--mk-space-14);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border-strong);
  font-family: var(--vp-font-family-mono);
}
.dtc-head-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.dtc-head-title {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}
.dtc-head-cap {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  margin-left: var(--mk-space-2);
}

.dtc-rail {
  display: flex;
  flex-direction: column;
  padding: var(--mk-space-6) 0;
}
.dtc-tab {
  display: flex;
  align-items: center;
  gap: var(--mk-space-10);
  padding: var(--mk-space-7) var(--mk-space-14);
  border-left: 2px solid transparent;
}
.dtc-tab:hover {
  background: var(--mk-hover-bg);
}
.dtc-on {
  background: color-mix(in srgb, var(--mk-accent) 8%, transparent);
  border-left-color: var(--brand);
}
.dtc-ic {
  font-size: var(--mk-space-14);
  color: var(--color-text-secondary);
  flex-shrink: 0;
}
.dtc-on .dtc-ic {
  color: var(--mk-accent);
}
.dtc-text {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-2);
  min-width: 0;
}
.dtc-name {
  font-size: var(--mk-fs-80);
  color: var(--color-text-secondary);
}
.dtc-on .dtc-name {
  color: var(--mk-text);
  font-weight: 600;
}
.dtc-role {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  line-height: 1.35;
}
</style>
