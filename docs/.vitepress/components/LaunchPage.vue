<template>
  <div class="launch-container">
    <div class="launch-header">
      <h1>Launch TeXRA Workspace</h1>
      <p class="subtitle">
        Start a GitHub Codespace with TeXLive and TeXRA pre-installed
      </p>
    </div>

    <div class="launch-form">
      <div class="form-group">
        <label for="repo-type">Repository Type</label>
        <select
          id="repo-type"
          v-model="repoType"
          @change="handleRepoTypeChange"
        >
          <option value="github-public">GitHub (Public)</option>
          <option value="github-private">GitHub (Private)</option>
          <option value="overleaf">Overleaf Git</option>
        </select>
      </div>

      <div class="form-group">
        <label for="repo-url">Repository URL</label>
        <input
          id="repo-url"
          v-model="repoUrl"
          type="text"
          placeholder="https://github.com/username/repo or https://git.overleaf.com/..."
          required
        />
        <small v-if="repoType === 'overleaf'">
          Get your Overleaf Git URL from Menu → Git in your Overleaf project
        </small>
      </div>

      <div v-if="repoType !== 'github-public'" class="auth-section">
        <h3>Authentication</h3>

        <div class="form-group">
          <label for="username">
            {{ repoType === 'overleaf' ? 'Overleaf Email' : 'GitHub Username' }}
          </label>
          <input
            id="username"
            v-model="username"
            type="text"
            :placeholder="
              repoType === 'overleaf' ? 'your@email.com' : 'github-username'
            "
          />
        </div>

        <div class="form-group">
          <label for="password">
            {{
              repoType === 'overleaf'
                ? 'Overleaf Git Token'
                : 'GitHub Personal Access Token'
            }}
          </label>
          <input
            id="password"
            v-model="password"
            type="password"
            :placeholder="
              repoType === 'overleaf'
                ? 'Your Overleaf Git token'
                : 'ghp_xxxxxxxxxxxx'
            "
          />
          <small v-if="repoType === 'github-private'">
            <a href="https://github.com/settings/tokens/new" target="_blank"
              >Create a token</a
            >
            with 'repo' scope
          </small>
          <small v-if="repoType === 'overleaf'">
            <a
              href="https://www.overleaf.com/learn/how-to/Git_integration_authentication_tokens"
              target="_blank"
            >
              Learn how to create an Overleaf Git token
            </a>
            <br />
            Your Overleaf email will be used for git commits
          </small>
        </div>
      </div>

      <div class="button-group">
        <button
          @click="launchCodespace"
          :disabled="!isValid"
          class="launch-button"
        >
          <span v-if="!loading">🚀 Launch Codespace</span>
          <span v-else>Preparing...</span>
        </button>
      </div>

      <div v-if="error" class="error-message">
        {{ error }}
      </div>

      <div class="info-box">
        <h4>What happens next?</h4>
        <ul>
          <li>A new GitHub Codespace will open with TeXLive pre-installed</li>
          <li>
            Your repository will be automatically cloned to the workspace root
          </li>
          <li>TeXRA extension will be available in VS Code</li>
          <li>You can start editing and committing immediately</li>
        </ul>
        <p
          style="margin-top: 1rem; color: var(--vp-c-text-3); font-size: 0.9rem"
        >
          <strong>⏱️ Note:</strong> First-time setup takes ~2 minutes to
          download TeXLive packages. Subsequent launches will be much faster
          thanks to Docker caching.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const repoType = ref('github-public');
const repoUrl = ref('');
const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

const handleRepoTypeChange = () => {
  // Clear auth fields when switching to public
  if (repoType.value === 'github-public') {
    username.value = '';
    password.value = '';
  }
  error.value = '';
};

const isValid = computed(() => {
  if (!repoUrl.value) return false;

  // Validate URL format
  try {
    const url = new URL(repoUrl.value);
    if (
      repoType.value === 'overleaf' &&
      !url.hostname.includes('overleaf.com')
    ) {
      return false;
    }
    if (
      repoType.value.startsWith('github') &&
      !url.hostname.includes('github.com')
    ) {
      return false;
    }
  } catch {
    return false;
  }

  // Check auth requirements
  if (repoType.value !== 'github-public') {
    if (!username.value || !password.value) return false;
  }

  return true;
});

const launchCodespace = async () => {
  error.value = '';
  loading.value = true;

  try {
    // Prepare configuration
    const config = {
      repoUrl: repoUrl.value,
      repoType: repoType.value,
    };

    // Add auth if needed
    if (repoType.value !== 'github-public') {
      config.username = username.value;
      config.password = password.value;
    }

    // For Overleaf repos, use the Overleaf email for git config
    if (repoType.value === 'overleaf') {
      // Use the username (Overleaf email) for both git name and email
      config.gitEmail = username.value;
      // Extract name from email (part before @) or use full email
      config.gitName = username.value.split('@')[0];
    }

    // Encode configuration as base64
    const configStr = JSON.stringify(config);
    const configBase64 = btoa(configStr);

    // Build Codespace URL
    const workspaceRepo = 'texra-ai/texra-workspace';
    const codespaceUrl = new URL(`https://github.com/codespaces/new`);

    // Add parameters
    codespaceUrl.searchParams.set('hide_repo_select', 'true');
    codespaceUrl.searchParams.set('ref', 'main');
    codespaceUrl.searchParams.set('repo', workspaceRepo);
    codespaceUrl.searchParams.set('skip_quickstart', 'true');

    // Add environment variable with config
    // Note: GitHub Codespaces doesn't support passing env vars via URL directly
    // We'll need to use a different approach - store config temporarily or use secrets

    // For now, we'll open the codespace and show instructions
    const instructionsUrl = `https://github.com/${workspaceRepo}?setup=${encodeURIComponent(configBase64)}`;

    // Store config in sessionStorage for manual retrieval
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('texra-launch-config', configBase64);
    }

    // Open the Codespace creation page
    window.open(codespaceUrl.toString(), '_blank');

    // Show success message with instructions
    error.value = `✅ Codespace creation page opened!\n\n📋 After the Codespace starts (~2 min first time), run this in the terminal:\n\necho '${configBase64}' | base64 -d > /tmp/texra-config.json && bash /workspaces/texra-workspace/.devcontainer/auto-setup.sh\n\n⚡ This will clone your repository and configure git. Future launches will be much faster!`;
  } catch (err) {
    error.value = `Error: ${err.message}`;
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped>
.launch-container {
  max-width: 800px;
  width: 90%;
  margin: 2rem auto;
  padding: 2rem;
}

.launch-header {
  text-align: center;
  margin-bottom: 2rem;
}

.launch-header h1 {
  font-size: 2rem;
  margin-bottom: 0.5rem;
}

.subtitle {
  color: var(--vp-c-text-2);
  font-size: 1.1rem;
}

.launch-form {
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  padding: 2rem;
}

@media (max-width: 768px) {
  .launch-container {
    width: 95%;
    padding: 1rem;
  }

  .launch-form {
    padding: 1.5rem;
  }
}

.form-group {
  margin-bottom: 1.5rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
  color: var(--vp-c-text-1);
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 0.9rem;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--vp-c-brand);
}

.form-group small {
  display: block;
  margin-top: 0.25rem;
  color: var(--vp-c-text-3);
  font-size: 0.85rem;
}

.form-group small a {
  color: var(--vp-c-brand);
}

.auth-section {
  background: var(--vp-c-bg);
  border-radius: 4px;
  padding: 1rem;
  margin: 1.5rem 0;
}

.auth-section h3 {
  margin-bottom: 1rem;
  font-size: 1.1rem;
}

.git-config-section {
  background: var(--vp-c-bg);
  border-radius: 4px;
  padding: 1rem;
  margin: 1.5rem 0;
}

.git-config-section h4 {
  margin-bottom: 1rem;
  font-size: 1rem;
  color: var(--vp-c-text-2);
}

.button-group {
  margin-top: 2rem;
}

.launch-button {
  width: 100%;
  padding: 0.75rem 1.5rem;
  background: var(--vp-c-brand);
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s;
}

.launch-button:hover:not(:disabled) {
  background: var(--vp-c-brand-dark);
}

.launch-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error-message {
  margin-top: 1rem;
  padding: 0.75rem;
  background: var(--vp-c-danger-soft);
  border: 1px solid var(--vp-c-danger);
  border-radius: 4px;
  color: var(--vp-c-danger);
  white-space: pre-wrap;
  word-break: break-all;
  overflow-wrap: break-word;
  font-family: monospace;
  font-size: 0.85rem;
  max-width: 100%;
  overflow-x: auto;
}

.info-box {
  margin-top: 2rem;
  padding: 1rem;
  background: var(--vp-c-bg);
  border-radius: 4px;
  border-left: 3px solid var(--vp-c-brand);
}

.info-box h4 {
  margin-bottom: 0.5rem;
  color: var(--vp-c-text-1);
}

.info-box ul {
  margin: 0;
  padding-left: 1.5rem;
}

.info-box li {
  margin: 0.25rem 0;
  color: var(--vp-c-text-2);
}
</style>
