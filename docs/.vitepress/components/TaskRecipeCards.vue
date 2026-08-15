<script setup>
// Frameless "Common Quick Tasks" slice: the three starter recipes from
// guide/quick-start.md, each shown as an agent + model + instruction triple —
// the same three controls you fill in the Launcher footer. Standalone (no
// MockupFrame); the root carries `.mockup` so the shared `--mk-*` colour +
// dimensional tokens resolve and the cards flip with the docs light/dark theme.
//
// Names mirror the page exactly: agents correct / paper2slide / polish, with
// the primary model and its alternatives kept as muted secondary text. Reuses
// the .select / .s-val / .s-caret chip and the .prompt block from the Launcher.
const recipes = [
  {
    icon: 'check',
    title: 'Fix grammar & typos',
    agent: 'correct',
    model: 'gemini37f',
    alts: 'deepseek, gpt56--, sonnet5',
    instruction:
      'Fix grammatical errors and typos without changing the content or technical terminology.',
  },
  {
    icon: 'file-export',
    title: 'Paper to slides',
    agent: 'paper2slide',
    model: 'sonnet5T',
    alts: 'opus5T, gpt56',
    instruction:
      'Convert this paper into presentation slides using the beamer template. Create approximately 12–15 slides highlighting the key points, methodology, and results.',
  },
  {
    icon: 'sparkle',
    title: 'Polish writing style',
    agent: 'polish',
    model: 'opus5',
    alts: 'sonnet5T',
    instruction:
      'Improve the writing style to make it more engaging and clear. Enhance the flow between paragraphs while preserving all technical content.',
  },
];
</script>

<template>
  <div class="mockup recipes" role="group" aria-label="common quick tasks">
    <article v-for="(r, i) in recipes" :key="i" class="rc">
      <header class="rc-head">
        <wa-icon class="rc-ic" library="texra" :name="r.icon"></wa-icon>
        <span class="rc-title">{{ r.title }}</span>
      </header>

      <div class="rc-controls">
        <div class="sgroup">
          <span class="iact settings" title="Agent">
            <wa-icon library="texra" name="sparkle"></wa-icon>
          </span>
          <div class="select">
            <span class="s-val">{{ r.agent }}</span>
            <wa-icon
              class="s-caret"
              library="texra"
              name="chevron-down"
            ></wa-icon>
          </div>
        </div>

        <div class="sgroup">
          <span class="iact settings" title="Model">
            <wa-icon library="texra" name="robot"></wa-icon>
          </span>
          <div class="select rc-model">
            <span class="s-val">{{ r.model }}</span>
            <span class="rc-alts">or {{ r.alts }}</span>
          </div>
        </div>
      </div>

      <div class="prompt rc-prompt">
        <wa-icon class="rc-quote" library="texra" name="quote"></wa-icon
        >{{ r.instruction }}
      </div>
    </article>
  </div>
</template>

<style scoped>
/* Standalone, frameless. All tokens come from `.mockup` (theme/mockup.css). */
.recipes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--mk-size-256), 1fr));
  gap: var(--mk-space-12);
  margin: var(--mk-space-12) 0;
  font-family: var(--vp-font-family-base);
}

.rc {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-10);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
  overflow: hidden;
}

.rc-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding-bottom: var(--mk-space-8);
  border-bottom: 1px solid var(--mk-border);
}
.rc-ic {
  font-size: var(--mk-space-14);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.rc-title {
  font-size: var(--mk-fs-82);
  font-weight: 600;
  color: var(--mk-text);
}

.rc-controls {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-7);
}

/* The model chip carries a muted "alternatives" trailer instead of a caret. */
.rc-model {
  flex-wrap: wrap;
  row-gap: 0;
}
.rc-alts {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  font-family: var(--vp-font-family-base);
}

.rc-prompt {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  gap: var(--mk-space-6);
  font-style: italic;
  color: var(--color-text-secondary);
  font-size: var(--mk-fs-78);
}
.rc-quote {
  flex-shrink: 0;
  margin-top: var(--mk-space-2);
  font-size: var(--mk-space-12);
  color: var(--mk-accent);
  opacity: 0.7;
}
</style>
