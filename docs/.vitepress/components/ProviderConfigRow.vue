<script setup>
// Frameless slice of one expanded "API Configuration" provider row from the
// Models tab. Both the "Using OpenRouter" and "Streaming" sections narrate the
// same interaction in prose — expand a provider row, then toggle streaming /
// "Use OpenRouter for All Models" — but never show what expansion reveals.
// ApiKeysHero only renders these rows collapsed (chevron-right, no body); this
// pulls a single row out, expanded (chevron-down), with the toggles + masked
// key field it exposes. Reuses the .api-table provider-row vocab and the
// bridged MockSwitch from ApiKeysHero.
import { ref } from 'vue';
import MockSwitch from './MockSwitch.vue';

const streaming = ref(true);
const openrouter = ref(false);
</script>

<template>
  <div class="mockup pcr" role="group" aria-label="Provider API configuration">
    <!-- Header row: expanded provider (chevron-down), status, actions. -->
    <div class="pcr-head">
      <div class="prov">
        <wa-icon
          class="prov-chev"
          library="texra"
          name="chevron-down"
        ></wa-icon>
        <span class="prov-name">OpenAI</span>
      </div>
      <span class="status status--set">
        <wa-icon library="texra" name="circle-check"></wa-icon>
        Key set
      </span>
      <div class="row-acts">
        <span class="key-btn" title="Set API key"
          ><wa-icon library="texra" name="key"></wa-icon
        ></span>
        <span class="key-btn" title="Get API key from provider"
          ><wa-icon library="texra" name="arrow-up-right-from-square"></wa-icon
        ></span>
        <span class="key-btn key-btn--rm" title="Remove key"
          ><wa-icon library="texra" name="trash"></wa-icon
        ></span>
      </div>
    </div>

    <!-- Expanded body: masked key + the two per-provider toggles. -->
    <div class="pcr-body">
      <div class="pcr-field">
        <label class="pcr-flabel">API key</label>
        <div class="pcr-key">
          <wa-icon class="pcr-key-ic" library="texra" name="key"></wa-icon>
          <span class="pcr-key-mask">sk-••••••••••••••••••••••••</span>
        </div>
      </div>

      <div class="pcr-toggle">
        <MockSwitch
          v-model="streaming"
          label="Enable streaming"
          description="Long responses arrive incrementally"
        />
      </div>

      <div class="pcr-toggle">
        <MockSwitch
          v-model="openrouter"
          label="Use OpenRouter for All Models"
          description="Route this provider's calls through OpenRouter"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.pcr {
  margin: var(--mk-space-16) 0;
  max-width: 480px;
  background: var(--mk-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius-lg);
  overflow: hidden;
  font-family: var(--vp-font-family-base);
}

/* Header mirrors the ApiKeysHero .api-table row layout, here as flex. */
.pcr-head {
  display: flex;
  align-items: center;
  gap: var(--mk-space-12);
  padding: var(--mk-space-8) var(--mk-space-12);
  background: var(--mk-bg-soft);
  border-bottom: 1px solid var(--mk-border);
}
.prov {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  flex: 1;
  min-width: 0;
}
.prov-chev {
  font-size: var(--mk-space-11);
  color: var(--mk-accent);
}
.prov-name {
  color: var(--wa-color-text-normal);
  font-weight: 500;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: var(--mk-space-5);
  font-size: var(--mk-fs-74);
  color: var(--color-success);
}
.status wa-icon {
  font-size: var(--mk-space-12);
}

.row-acts {
  display: flex;
  gap: var(--mk-space-2);
}
.key-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--mk-size-24);
  height: var(--mk-size-24);
  border-radius: var(--mk-radius);
  color: var(--color-text-secondary);
  font-size: var(--mk-space-12);
  cursor: pointer;
}
.key-btn:hover {
  background: var(--mk-hover-bg);
  color: var(--wa-color-text-normal);
}
.key-btn--rm:hover {
  color: var(--color-error);
}

.pcr-body {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-12);
  padding: var(--mk-space-12) var(--mk-space-14);
}
.pcr-field {
  display: flex;
  flex-direction: column;
  gap: var(--mk-space-5);
}
.pcr-flabel {
  font-size: var(--mk-fs-66);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}
.pcr-key {
  display: flex;
  align-items: center;
  gap: var(--mk-space-7);
  background: var(--mk-bg-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius-md);
  padding: var(--mk-space-6) var(--mk-space-9);
}
.pcr-key-ic {
  font-size: var(--mk-space-12);
  color: var(--color-text-tertiary);
}
.pcr-key-mask {
  font-family: var(--vp-font-family-mono);
  font-size: var(--mk-fs-80);
  letter-spacing: 0.04em;
  color: var(--wa-color-text-normal);
}
.pcr-toggle {
  padding: var(--mk-space-8) var(--mk-space-10);
  background: var(--mk-bg-soft);
  border: 1px solid var(--color-border);
  border-radius: var(--mk-radius-lg);
}
</style>
