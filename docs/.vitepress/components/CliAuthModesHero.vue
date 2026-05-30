<script setup>
// Frameless two-card comparison for the CLI's two credential paths, plus the
// per-run `--api-mode` override. The Authentication section of guide/texra-cli.md
// narrates this branch across several paragraphs: (1) sign in with GitHub/Google
// for included hosted access, (2) bring your own provider keys via env vars, and
// (3) the `--api-mode personal|included` flag that flips a single run even while
// signed in. The relationship between "signed in" and "which credential a run
// uses" is exactly the kind of branching a side-by-side card makes explicit.
//
// Frameless and .mockup-scoped, so it inherits the shared --mk-* colour +
// dimensional tokens and flips cleanly between the docs light / dark themes.
// Composes StatusPill for the alias chips — no bespoke pill CSS.
import StatusPill from './StatusPill.vue';

// Env-var rows for the BYOK card. The first carries a masked value to mirror the
// `export ANTHROPIC_API_KEY=sk-…` line in the prose; the siblings are listed bare.
const envVars = [
  { name: 'ANTHROPIC_API_KEY', value: 'sk-…' },
  { name: 'OPENAI_API_KEY', value: '' },
  { name: 'GOOGLE_API_KEY', value: '' },
];
</script>

<template>
  <div class="mockup cam" role="group" aria-label="CLI authentication modes">
    <div class="cam-cards">
      <!-- Included / hosted -->
      <section class="cam-col">
        <header class="cam-head">
          <wa-icon
            class="cam-ic cam-ic--hosted"
            library="texra"
            name="cloud"
          ></wa-icon>
          <span class="cam-title">Included</span>
          <StatusPill variant="info" shape="pill">hosted</StatusPill>
        </header>
        <div class="cam-id">
          <wa-icon class="cam-id-ic" library="texra" name="account"></wa-icon>
          <span class="cam-id-name">you@github</span>
        </div>
        <code class="cam-cmd">texra login</code>
        <p class="cam-note">Sign in with GitHub or Google.</p>
        <div class="cam-foot">
          <StatusPill variant="success" shape="pill" icon="check"
            >No keys to manage</StatusPill
          >
        </div>
      </section>

      <!-- Personal keys / BYOK -->
      <section class="cam-col">
        <header class="cam-head">
          <wa-icon
            class="cam-ic cam-ic--byok"
            library="texra"
            name="key"
          ></wa-icon>
          <span class="cam-title">Personal keys</span>
          <StatusPill variant="accent" shape="pill">BYOK</StatusPill>
        </header>
        <ul class="cam-envs">
          <li v-for="e in envVars" :key="e.name" class="cam-env">
            <span class="cam-env-name">{{ e.name }}</span>
            <span v-if="e.value" class="cam-env-eq">=</span>
            <span v-if="e.value" class="cam-env-val">{{ e.value }}</span>
          </li>
        </ul>
        <p class="cam-note">Set the provider env var, then run as usual.</p>
        <div class="cam-foot">
          <StatusPill variant="neutral" shape="pill"
            >No sign-in needed</StatusPill
          >
        </div>
      </section>
    </div>

    <!-- Per-run override strip -->
    <div class="cam-override">
      <wa-icon class="cam-ov-ic" library="texra" name="arrows-rotate"></wa-icon>
      <span class="cam-ov-label">Per-run override</span>
      <code class="cam-ov-flag">--api-mode personal</code>
      <span class="cam-ov-desc">uses your key even while signed in</span>
      <span class="cam-ov-aliases">
        <StatusPill variant="accent" shape="chip">direct</StatusPill>
        <StatusPill variant="accent" shape="chip">api</StatusPill>
        <StatusPill variant="accent" shape="chip">byok</StatusPill>
        <span class="cam-ov-vs">vs</span>
        <StatusPill variant="info" shape="chip">included</StatusPill>
      </span>
    </div>
  </div>
</template>

<style scoped>
.cam {
  margin: var(--mk-space-16) 0;
  font-family: var(--vp-font-family-base);
}
.cam-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--mk-space-12);
}
.cam-col {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-8);
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  padding: var(--mk-space-12) var(--mk-space-14);
}
.cam-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding-bottom: var(--mk-space-7);
  border-bottom: 1px solid var(--mk-border);
}
.cam-ic {
  font-size: var(--mk-space-14);
}
.cam-ic--hosted {
  color: var(--mk-syn-fn);
}
.cam-ic--byok {
  color: var(--mk-accent);
}
.cam-title {
  font-size: var(--mk-fs-84);
  font-weight: 700;
  color: var(--mk-text);
}

/* hosted identity chip */
.cam-id {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-6);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-pill);
  padding: var(--mk-space-3) var(--mk-space-9);
  align-self: flex-start;
}
.cam-id-ic {
  font-size: var(--mk-space-12);
  color: var(--mk-syn-fn);
}
.cam-id-name {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  color: var(--mk-text);
}

.cam-cmd {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: var(--mk-space-2) var(--mk-space-7);
  align-self: flex-start;
}

/* BYOK env-var rows */
.cam-envs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-4);
}
.cam-env {
  display: flex;
  align-items: baseline;
  gap: var(--mk-space-4);
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  min-width: 0;
}
.cam-env-name {
  color: var(--mk-syn-keyword);
  word-break: break-all;
}
.cam-env-eq {
  color: var(--mk-text-faint);
}
.cam-env-val {
  color: var(--mk-text-faint);
}

.cam-note {
  margin: 0;
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
  line-height: 1.45;
}
.cam-foot {
  margin-top: auto;
  padding-top: var(--mk-space-2);
}

/* Override strip */
.cam-override {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-10);
  padding: var(--mk-space-9) var(--mk-space-12);
  background: var(--mk-bg-soft);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
}
.cam-ov-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-accent);
  flex-shrink: 0;
}
.cam-ov-label {
  font-size: var(--mk-fs-68);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
}
.cam-ov-flag {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-74);
  color: var(--mk-accent);
  background: color-mix(in srgb, var(--mk-accent) 12%, transparent);
  border-radius: var(--mk-radius-sm);
  padding: var(--mk-space-2) var(--mk-space-7);
}
.cam-ov-desc {
  font-size: var(--mk-fs-72);
  color: var(--color-text-secondary);
}
.cam-ov-aliases {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--mk-space-5);
  margin-left: auto;
}
.cam-ov-vs {
  font-size: var(--mk-fs-70);
  color: var(--mk-text-faint);
  padding: 0 var(--mk-space-2);
}

@media (max-width: 560px) {
  .cam-cards {
    grid-template-columns: 1fr;
  }
  .cam-ov-aliases {
    margin-left: 0;
    flex-basis: 100%;
  }
}
</style>
