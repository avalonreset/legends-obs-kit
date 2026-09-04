# Agent compatibility

The skill follows the open Agent Skills `SKILL.md` format with required `name` and `description` frontmatter. The CLI is the deterministic runtime; the model only chooses and sequences commands.

| Agent | User-level skill location | Status |
|---|---|---|
| Codex | `%USERPROFILE%\.agents\skills\legends-obs-kit` | Official discovery path |
| Claude Code | `%USERPROFILE%\.claude\skills\legends-obs-kit` | Official discovery path |
| Gemini CLI | `%USERPROFILE%\.gemini\skills\legends-obs-kit` or `%USERPROFILE%\.agents\skills\legends-obs-kit` | Official discovery paths |
| Grok-based local agents | `%USERPROFILE%\.grok\skills\legends-obs-kit` | Compatibility link; discovery depends on the host application |
| OpenCode | `%USERPROFILE%\.config\opencode\skills\legends-obs-kit` | Compatibility link |

Run the installer from the cloned repository:

```powershell
pwsh -NoProfile -File .\bin\setup-multi-agent.ps1
```

The installer builds the CLI when needed, reuses the prebuilt CLI in an extracted release, creates missing parent directories, refuses to overwrite existing folders or foreign links, and is idempotent for links that already target this install. Agents without native skill discovery can still read `AGENTS.md` and run the CLI directly.

Primary discovery references: [OpenAI Codex skills](https://developers.openai.com/codex/skills), [Claude Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), and [Gemini CLI Agent Skills](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/using-agent-skills.md).
