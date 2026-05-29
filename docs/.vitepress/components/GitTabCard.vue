<script setup>
// Frameless Dashboard → Git tab. Mirrors the two independent features the
// configuration.md "Git Integration" prose describes: (1) the GitHub
// personal-access-token row — stored in encrypted Secret Storage, or detected
// from a GITHUB_TOKEN env var (shown as the "Env" status), with Create on
// GitHub / Set token actions; and (2) the "Mark commits with TeXRA author
// info" toggle that sets GIT_AUTHOR_* for agent commits. Reuses ApiKeysHero's
// status-pill vocabulary (.status--set/--env) plus the shared MockSwitch
// primitive; the frameless `.mockup` shell inherits the --mk-* tokens and
// flips with the docs theme.
import { ref } from 'vue';
import MockSwitch from './MockSwitch.vue';

const authorInfo = ref(true);
</script>

<template>
  <div class="mockup gtc" role="group" aria-label="Git tab">
    <div class="gtc-head">
      <wa-icon class="gtc-head-ic" library="texra" name="code-branch"></wa-icon>
      <span class="gtc-head-title">Git</span>
    </div>

    <div class="gtc-body">
      <!-- GitHub personal-access-token row -->
      <div class="gtc-section">
        <div class="gtc-row">
          <span class="gtc-row-label">GitHub token</span>
          <span class="status status--env">
            <wa-icon library="texra" name="circle-check"></wa-icon>
            Env
          </span>
        </div>
        <p class="gtc-sub">
          Read from <code>GITHUB_TOKEN</code>, or stored in encrypted Secret
          Storage.
        </p>
        <div class="gtc-acts">
          <span class="gtc-btn">
            <wa-icon
              library="texra"
              name="arrow-up-right-from-square"
            ></wa-icon>
            Create on GitHub…
          </span>
          <span class="gtc-btn">
            <wa-icon library="texra" name="key"></wa-icon>
            Set token
          </span>
        </div>
      </div>

      <div class="gtc-divider"></div>

      <!-- TeXRA commit-author toggle -->
      <div class="gtc-section">
        <MockSwitch
          v-model="authorInfo"
          label="Mark commits with TeXRA author info"
        />
        <p class="gtc-sub">
          Sets <code>GIT_AUTHOR_NAME/EMAIL</code> for agent commits.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The status pill (.status--set/--env) and the switch live in mockup.css; only
   the Git-tab shell + row scaffolding is unique here. No raw hex / px. */
.gtc {
  background: var(--mk-bg);
  border: 1px solid var(--mk-border-soft);
  border-radius: var(--mk-radius-lg);
  margin: var(--mk-space-16) auto;
  max-width: var(--mk-size-470);
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

.gtc-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  padding: var(--mk-space-8) var(--mk-space-14);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border-strong);
  font-family: var(--vp-font-family-mono);
}
.gtc-head-ic {
  font-size: var(--mk-space-13);
  color: var(--mk-syn-fn);
  flex-shrink: 0;
}
.gtc-head-title {
  font-size: var(--mk-fs-76);
  font-weight: 600;
  color: var(--mk-text);
}

.gtc-body {
  padding: var(--mk-space-14) var(--mk-space-16);
}
.gtc-section {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-7);
}

.gtc-row {
  display: flex;
  align-items: center;
  gap: var(--mk-space-10);
}
.gtc-row-label {
  font-size: var(--mk-fs-82);
  font-weight: 600;
  color: var(--mk-text);
}

/* Local copy of ApiKeysHero's status pill (kept self-contained). */
.status {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-74);
}
.status wa-icon {
  font-size: var(--mk-space-12);
}
.status--set {
  color: var(--color-success);
}
.status--env {
  color: var(--wa-color-icon-info);
}

.gtc-sub {
  margin: 0;
  font-size: var(--mk-fs-74);
  line-height: 1.45;
  color: var(--color-text-secondary);
}
.gtc-sub code {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-70);
  color: var(--mk-text-dim);
}

.gtc-acts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--mk-space-7);
  margin-top: var(--mk-space-2);
}
.gtc-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  padding: var(--mk-space-5) var(--mk-space-10);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius);
  background: var(--mk-bg-raised);
  color: var(--wa-color-text-normal);
  font-size: var(--mk-fs-76);
  cursor: pointer;
}
.gtc-btn wa-icon {
  font-size: var(--mk-space-12);
  color: var(--color-text-secondary);
}
.gtc-btn:hover {
  background: var(--mk-hover-bg);
}

.gtc-divider {
  height: 1px;
  background: var(--mk-border);
  margin: var(--mk-space-14) 0;
}
</style>
