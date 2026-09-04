#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
skill="$repo/skills/legends-obs-kit"

cd "$repo"
if [[ ! -f "$repo/dist/index.js" ]]; then
  if [[ ! -f "$repo/src/index.ts" ]]; then
    echo "missing built CLI and source tree; re-download the complete release or repository" >&2
    exit 1
  fi
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
fi

link_skill() {
  local target="$1"
  mkdir -p "$(dirname "$target")"
  if [[ -e "$target" && ! -L "$target" ]]; then
    echo "refusing to replace existing non-symlink: $target" >&2
    return 1
  fi
  if [[ -L "$target" ]]; then
    local current
    current="$(readlink "$target")"
    if [[ "$current" == "$skill" ]]; then
      echo "already linked: $target"
      return
    fi
    echo "refusing to replace a link owned by another installation: $target -> $current" >&2
    return 1
  fi
  ln -s "$skill" "$target"
  echo "linked $target"
}

link_skill "$HOME/.agents/skills/legends-obs-kit"
link_skill "$HOME/.claude/skills/legends-obs-kit"
link_skill "$HOME/.grok/skills/legends-obs-kit"
link_skill "$HOME/.gemini/skills/legends-obs-kit"
link_skill "$HOME/.config/opencode/skills/legends-obs-kit"
