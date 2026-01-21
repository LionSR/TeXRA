# Remote Agents

Remote agents are cloud-hosted AI agents maintained by the TeXRA team. They receive automatic updates without requiring extension updates and load on-demand to keep your extension lightweight.

## Getting Started

### 1. Sign In

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run: **TeXRA: Sign In**
3. Choose your sign-in method (GitHub, Google, or GitLab)
4. Complete authentication in your browser

### 2. Browse Available Agents

1. Run: **TeXRA: View Profile**
2. Browse the **Remote Agents** table
3. Click **Use** on any agent to add it to your selector

### 3. Use Remote Agents

1. Open the TeXRA view
2. Select your remote agent from the dropdown (marked with a cloud icon)
3. Choose input file and model
4. Click **Run**

## Research Access Program

The Research Access Program provides access to specialized agents for academic research:

- Domain-specific agents (mathematics, physics, computer science)
- Advanced reasoning capabilities
- Beta features and early access
- Priority feedback handling

### Joining

The program is free for researchers. Contact [contact@texra.ai](mailto:contact@texra.ai) with:
- Your name and affiliation
- Brief description of your research area
- How you plan to use remote agents

## Managing Your Account

- **View profile**: Run **TeXRA: View Profile**
- **Sign out**: Run **TeXRA: Sign Out**

Local agents continue to work after signing out.

## FAQ

**Do I need to sign in to use TeXRA?**
No. Built-in agents work fully offline. Sign in is only needed for remote agents.

**Are remote agents slower?**
No. Only the agent configuration loads from the cloud. Model execution uses your API keys locally.

**What happens to my documents?**
Documents are never uploaded to TeXRA servers. All processing happens locally.

**Can I disable remote agents?**
Yes. Set `texra.remoteAgents.enabled` to false in VS Code settings.

## Contact

- Email: [contact@texra.ai](mailto:contact@texra.ai)
- Documentation: [texra.ai/guide](https://texra.ai/guide)
