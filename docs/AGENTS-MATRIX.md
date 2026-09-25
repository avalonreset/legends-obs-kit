# Agent compatibility

All agents reach this kit through the one registered `cto-legends` router
skill (vendored at `skills/cto-legends/SKILL.md`). There is no per-module
skill directory and no per-host skill installer: run
`cto-legends install legends-obs-kit` to preview the install, then follow the
module recipe the router loads. The CLI is the deterministic runtime; the
model only chooses and sequences commands. Agents without router access can
still read `AGENTS.md` and run the CLI directly.

Primary discovery references: [OpenAI Codex skills](https://developers.openai.com/codex/skills), [Claude Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), and [Gemini CLI Agent Skills](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/using-agent-skills.md).
