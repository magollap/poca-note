#!/usr/bin/env bash
#
# poca-note uninstaller for macOS and Linux.
#
#   ./scripts/uninstall.sh              remove dependencies and the web build
#   ./scripts/uninstall.sh --purge      also remove .env and data/ (your database)
#   ./scripts/uninstall.sh --dry-run    show what would be removed, change nothing
#   ./scripts/uninstall.sh --stop       stop a running server first
#   ./scripts/uninstall.sh --yes        do not ask for confirmation
#   ./scripts/uninstall.sh --help       show every option
#
# Source code, tests, and README.md are never deleted. To remove the whole
# project folder, see the Uninstalling section in README.md.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PURGE=0
DRY_RUN=0
ASSUME_YES=0
STOP=0

usage() {
  cat <<'EOF'
poca-note uninstaller (macOS / Linux)

Usage:
  ./scripts/uninstall.sh [options]

By default this removes node_modules/ and web/dist/ and keeps your data.

Options:
  --purge     Also remove .env, .env.local, and data/ (database + backups)
  --stop      Stop a running poca-note server before removing files
  --dry-run   Show what would be removed without deleting anything
  --yes       Skip the confirmation prompt
  -h, --help  Show this help

Examples:
  ./scripts/uninstall.sh --dry-run
  ./scripts/uninstall.sh
  ./scripts/uninstall.sh --purge
  ./scripts/uninstall.sh --stop --purge --yes
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1 ;;
    --stop) STOP=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

if [[ -t 1 ]]; then
  C_INFO="\033[36m"; C_OK="\033[32m"; C_WARN="\033[33m"; C_ERR="\033[31m"; C_RESET="\033[0m"
else
  C_INFO=""; C_OK=""; C_WARN=""; C_ERR=""; C_RESET=""
fi

info() { printf "%b==> %s%b\n" "$C_INFO" "$*" "$C_RESET"; }
ok()   { printf "%b  OK  %s%b\n" "$C_OK" "$*" "$C_RESET"; }
warn() { printf "%b  !!  %s%b\n" "$C_WARN" "$*" "$C_RESET"; }
err()  { printf "%b  XX  %s%b\n" "$C_ERR" "$*" "$C_RESET" >&2; }

# Refuse to touch anything that is not this project.
assert_project() {
  if [[ ! -f "$ROOT/package.json" ]]; then
    err "No package.json in $ROOT; refusing to continue."
    exit 1
  fi
  if ! grep -qE '"name"[[:space:]]*:[[:space:]]*"poca-note"' "$ROOT/package.json"; then
    err "This does not look like the poca-note project ($ROOT)."
    exit 1
  fi
}

read_env_value() {
  local key="$1" file="$ROOT/.env"
  [[ -f "$file" ]] || return 0
  sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$file" \
    | tail -n1 \
    | sed -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

port_pid() {
  local port="$1" pid=""
  if command -v ss >/dev/null 2>&1; then
    pid="$(ss -ltnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p {print}' \
      | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2 || true)"
  fi
  if [[ -z "$pid" ]] && command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null | head -n1 || true)"
  fi
  printf '%s' "$pid"
}

stop_server() {
  local port="$1"
  if ! port_open "$port"; then
    ok "Nothing is listening on port $port."
    return 0
  fi

  local pid cmdline=""
  pid="$(port_pid "$port")"
  if [[ -z "$pid" ]]; then
    pid="$(pgrep -f "$ROOT/scripts/start.mjs" 2>/dev/null | head -n1 || true)"
  fi
  if [[ -z "$pid" ]]; then
    warn "Port $port is in use, but the owning process could not be identified."
    warn "Stop it manually, for example: ss -ltnp | grep ':${port}'"
    return 1
  fi

  # Only signal a process that looks like this app.
  if [[ -r "/proc/$pid/cmdline" ]]; then
    cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  elif command -v ps >/dev/null 2>&1; then
    cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  fi
  if [[ -n "$cmdline" ]] && ! grep -qE 'start\.mjs|server/index\.js|dev\.mjs|vite' <<< "$cmdline"; then
    err "Process $pid does not look like poca-note: $cmdline"
    err "Stop it manually and re-run this script."
    return 1
  fi

  info "Stopping poca-note (pid $pid)..."
  kill "$pid" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if ! port_open "$port"; then
      ok "Server stopped."
      return 0
    fi
    sleep 0.25
  done

  warn "Server did not stop; sending SIGKILL."
  kill -9 "$pid" 2>/dev/null || true
  sleep 0.5
  if port_open "$port"; then
    err "Port $port is still in use."
    return 1
  fi
  ok "Server stopped."
}

human_size() {
  local path="$1"
  [[ -e "$path" ]] || { printf '0'; return 0; }
  du -sh "$path" 2>/dev/null | cut -f1
}

info "poca-note uninstaller"
info "Project: $ROOT"
assert_project

PORT="$(read_env_value PORT)"
PORT="${PORT:-${PORT_ENV:-8787}}"

TARGETS=("$ROOT/node_modules" "$ROOT/web/dist")
if (( PURGE )); then
  TARGETS+=("$ROOT/.env" "$ROOT/.env.local" "$ROOT/data")
fi

EXISTING=()
for target in "${TARGETS[@]}"; do
  [[ -e "$target" ]] && EXISTING+=("$target")
done

if (( ${#EXISTING[@]} == 0 )); then
  if (( STOP )); then
    stop_server "$PORT" || true
  fi
  ok "Nothing to remove; this install is already clean."
  if (( PURGE )); then
    echo "  Dependencies, web build, .env, and data/ are all gone."
  fi
  exit 0
fi

info "The following will be removed:"
for target in "${EXISTING[@]}"; do
  printf '    %s (%s)\n' "${target#"$ROOT"/}" "$(human_size "$target")"
done

if (( PURGE )); then
  warn "This deletes your database and every backup in data/."
else
  echo
  ok "Keeping .env and data/ (database, backups, settings)."
  echo "     Use --purge to delete them too."
fi

if (( DRY_RUN )); then
  echo
  ok "Dry run: nothing was deleted."
  exit 0
fi

if (( ! ASSUME_YES )); then
  echo
  printf 'Continue? [y/N] '
  read -r reply || reply=""
  case "$reply" in
    y|Y|yes|YES) ;;
    *) warn "Cancelled. Nothing was deleted."; exit 1 ;;
  esac
fi

if (( STOP )); then
  stop_server "$PORT" || true
elif port_open "$PORT"; then
  warn "poca-note is still running on port $PORT."
  warn "Stop it first (or re-run with --stop); deleting files under a running server can leave it unstable."
fi

for target in "${EXISTING[@]}"; do
  info "Removing ${target#"$ROOT"/}..."
  if ! rm -rf -- "$target"; then
    err "Failed to remove $target"
    err "If it is root-owned, fix permissions: sudo chown -R \$USER:\$USER \"$ROOT\""
    exit 1
  fi
done

echo
ok "Uninstalled poca-note from $ROOT."
if (( PURGE )); then
  echo "  Dependencies, the web build, .env, and data/ are gone."
  echo "  Remove the remaining source files with:"
  echo "    cd \"$(dirname "$ROOT")\" && rm -rf \"$(basename "$ROOT")\""
else
  echo "  Dependencies and the web build are gone; your data is untouched."
  echo "  Remove .env and data/ as well:  ./scripts/uninstall.sh --purge"
  echo "  Reinstall:                      ./scripts/install.sh"
fi
