# Remote Agents

Remote agents are cloud-hosted AI agents maintained by the TeXRA team that extend your extension's capabilities with specialized functionality. They're automatically updated with the latest improvements and optimizations without requiring extension updates.

## What Are Remote Agents?

Remote agents are pre-configured AI assistants hosted in the cloud that you can access directly from TeXRA. Unlike built-in agents, they:

- Receive updates automatically without requiring extension updates
- Provide specialized capabilities for specific research domains
- Load on-demand to keep your extension lightweight

## Getting Started

### 1. Sign In to TeXRA

To access remote agents, you need a TeXRA account:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run the command: **TeXRA: Sign In**
3. Choose your preferred sign-in method (GitHub, Google, or GitLab)
4. Complete the authentication flow in your browser
5. Return to VS Code once authenticated

::: tip
You can check your authentication status anytime by running **TeXRA: View Profile** from the Command Palette.
:::

### 2. Browse Available Agents

Once signed in, you can explore remote agents from your profile:

1. Open the Command Palette
2. Run: **TeXRA: View Profile**
3. Browse the **Remote Agents** table showing all available agents
4. Click **Use** on any agent to add it to your agent selector

The selected agent will appear in your main TeXRA view alongside your built-in agents.

### 3. Use Remote Agents

Remote agents work just like built-in agents:

1. Open the TeXRA view (click the TeXRA icon in the Activity Bar)
2. Select your remote agent from the agent dropdown
3. Choose your input file and model
4. Click **Run** to execute the agent

::: info
Remote agents are marked with a cloud icon (☁️) in the agent selector to distinguish them from local agents.
:::

## Research Access Program

The **Research Access Program** provides access to specialized remote agents designed for academic research and professional writing. Program members get access to:

- **Specialized domain agents**: Agents tailored for specific research fields (mathematics, computer science, physics, etc.)
- **Advanced reasoning capabilities**: Multi-step analysis and complex document processing
- **Beta features**: Early access to experimental agents and capabilities
- **Priority improvements**: Your feedback directly influences agent development

Different agents may be available to different research groups based on their domain and needs.

### Joining the Program

The Research Access Program is available to active researchers, academics, and technical writers. To join:

1. **Sign in** to TeXRA using your institutional or professional email
2. **Contact us** at [contact@texra.ai](mailto:contact@texra.ai) with:
   - Your name and affiliation
   - Brief description of your research area
   - How you plan to use remote agents

We'll review your application and grant appropriate access within 1-2 business days.

::: tip Free for Researchers
TeXRA is committed to supporting academic research. The Research Access Program is **free for qualifying researchers and students**. We do not charge for remote agent access.
:::

## Managing Your Account

### View Your Profile

Check your account status and available agents:

1. Open Command Palette
2. Run: **TeXRA: View Profile**
3. View your email, user ID, and access level
4. Browse remote agents available to you

### Sign Out

To sign out of your TeXRA account:

1. Open Command Palette
2. Run: **TeXRA: Sign Out**
3. Confirm sign out

Your local agents will continue to work normally after signing out. You'll only lose access to remote agents until you sign in again.

## Frequently Asked Questions

### Do I need to sign in to use TeXRA?

No. TeXRA works fully offline with built-in agents. You only need to sign in if you want access to remote agents from the cloud.

### Are remote agents slower than built-in agents?

Remote agents perform similarly to built-in agents. The agent configuration is loaded from the cloud, but the actual AI model execution happens using your configured API keys just like with built-in agents.

### Can I use remote agents offline?

No. Remote agents require an internet connection to load their configurations. If you need offline access, use built-in agents instead.

### What happens to my documents?

Your documents are never uploaded to TeXRA servers. Remote agents only load their configuration (prompts and settings) from the cloud. All document processing happens locally using your own API keys.

### Can I create my own remote agents?

Currently, remote agents are maintained by the TeXRA team. If you have ideas for new agents or want to share your custom agents with the community, contact us at [contact@texra.ai](mailto:contact@texra.ai).

### How do I disable remote agents?

If you prefer not to use remote agents:

1. Open VS Code Settings (`Ctrl+,` / `Cmd+,`)
2. Search for: `texra.remoteAgents.enabled`
3. Uncheck the setting

This will hide remote agents from your interface without affecting built-in agents.

## Need Help?

If you encounter any issues with remote agents or have questions about the Researcher Access Program:

- **Email**: [contact@texra.ai](mailto:contact@texra.ai)
- **Documentation**: [texra.ai/guide](https://texra.ai/guide)

We typically respond to inquiries within 24-48 hours.
