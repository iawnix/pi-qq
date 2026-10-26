#!/usr/bin/env bash
set -euo pipefail
FRIEND_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$FRIEND_ROOT"
umask 077
export PI_CODING_AGENT_DIR="$FRIEND_ROOT/.runtime/pi-agent"
export PI_QQ_CONFIG="$FRIEND_ROOT/qqbot.json"
mkdir -p "$PI_CODING_AGENT_DIR" "$FRIEND_ROOT/.runtime/console-sessions"
if ! command -v pi >/dev/null 2>&1; then
  echo '找不到 pi，请先安装 Pi 并将其加入 PATH。' >&2
  exit 1
fi
exec pi --no-extensions --no-skills --no-prompt-templates --no-themes \
  -e "$FRIEND_ROOT/src/extension.ts" \
  --session-dir "$FRIEND_ROOT/.runtime/console-sessions" "$@"
