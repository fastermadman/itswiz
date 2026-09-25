#!/bin/bash
# PreToolUse(Bash + filesystem move_file): afvis rå flytning/omdøbning af vault-filer.
# Obsidians egen move opdaterer [[wikilinks]]; mv/cp gør ikke. Se CLAUDE.md.
in=$(cat)
tool=$(jq -r '.tool_name' <<<"$in")
if [[ "$tool" == "Bash" ]]; then
  cmd=$(jq -r '.tool_input.command // ""' <<<"$in")
  grep -Eq '(^|[;&|[:space:]])(mv|cp)[[:space:]]' <<<"$cmd" \
    && grep -Eq 'ViaVault|ValdiVault' <<<"$cmd" || exit 0
else
  jq -r '.tool_input | [.source, .destination] | join(" ")' <<<"$in" | grep -Eq 'ViaVault|ValdiVault' || exit 0
fi
echo "Flyt/omdøb ikke vault-filer med rå filsystem-værktøjer: brug mcp__enquire__obsidian_rename_note eller Local REST API MOVE (wikilinks følger med)." >&2
exit 2
