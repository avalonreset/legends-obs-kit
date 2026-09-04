# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** flow for this repository. Do not include OBS WebSocket passwords, stream keys, service credentials, recordings, logs, or private configuration files in a public issue.

## Trust boundary

Legends OBS Kit reads the local OBS configuration only to authenticate to OBS's loopback WebSocket server. It must not print, copy, or persist the WebSocket password. Mutations are dry-run by default and require both `LEGENDS_OBS_DRY_RUN=false` and `--confirm`.

Review any skill before installing it: an agent skill is executable instruction content and inherits the permissions of the agent running it.
