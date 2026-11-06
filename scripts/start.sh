#!/usr/bin/env bash
#
# poca-note launcher — starts the app without npm.
#
# Usage:
#   scripts/start.sh [start]   start in the background (logs to logs/poca-note.log)
#   scripts/start.sh run       run in the foreground (used by the systemd unit)
#   scripts/start.sh stop      stop a background instance
#   scripts/start.sh restart   stop, then start
#   scripts/start.sh status    show whether the app is running
#
# All modes are idempotent: starting twice is safe, and `start` detects an
# instance already managed by systemd instead of fighting it for the port.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/data/poca-note.pid"
LOG_DIR="$ROOT_DIR/logs"
LOG_FILE="$LOG_DIR/poca-note.log"
SERVICE_UNIT="poca-note.service"

say() { printf '[start.sh] %s\n' "$*"; }
die() { printf '[start.sh] error: %s\n' "$*" >&2; exit 1; }

resolve_node() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    printf '%s' "$NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # systemd/detached shells may not have nvm loaded; fall back to the newest nvm node.
  local candidate
  candidate="$(ls -1d /home/*/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n1 || true)"
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    printf '%s' "$candidate"
    return 0
  fi
  die "node not found. Install Node.js >= 22.13 or set NODE_BIN=/path/to/node."
}

read_port() {
  local port="${PORT:-}"
  if [[ -z "$port" && -f "$ROOT_DIR/.env" ]]; then
    port="$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*//p' "$ROOT_DIR/.env" \
      | tail -n1 | tr -d '"'"'"'[:space:]')"
  fi
  printf '%s' "${port:-8787}"
}

pid_is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -dc '0-9' <"$PID_FILE")"
  pid_is_alive "$pid" || return 1
  printf '%s' "$pid"
}

port_answers() {
  local port="$1"
  if command -v curl >/dev/null 2>&1; then
    local code
    code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:${port}/" || true)"
    [[ -n "$code" && "$code" != "000" ]]
    return
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/${port}") >/dev/null 2>&1
}

wait_for_app() {
  local port="$1" timeout="${2:-20}" i=0
  while (( i < timeout * 5 )); do
    if port_answers "$port"; then return 0; fi
    sleep 0.2
    i=$((i + 1))
  done
  return 1
}

systemd_active() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user is-active --quiet "$SERVICE_UNIT" 2>/dev/null
}

do_start() {
  local port node pid
  port="$(read_port)"
  node="$(resolve_node)"

  if pid="$(running_pid)"; then
    say "already running (pid ${pid}) on http://localhost:${port}"
    return 0
  fi
  rm -f "$PID_FILE"

  if systemd_active; then
    say "already managed by systemd (${SERVICE_UNIT}) on http://localhost:${port}"
    return 0
  fi
  if port_answers "$port"; then
    say "something is already listening on port ${port}; assuming poca-note is up."
    say "open http://localhost:${port}"
    return 0
  fi

  mkdir -p "$LOG_DIR" "$(dirname "$PID_FILE")"
  cd "$ROOT_DIR"

  say "starting poca-note with ${node}"
  nohup "$node" "$ROOT_DIR/server/index.js" >>"$LOG_FILE" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"

  if ! wait_for_app "$port" 25; then
    say "server did not become reachable; last log lines:"
    tail -n 20 "$LOG_FILE" >&2 || true
    return 1
  fi
  say "up on http://localhost:${port} (pid ${pid})"
  say "logs: ${LOG_FILE}"
  say "stop with: scripts/start.sh stop"
}

do_run() {
  local node
  node="$(resolve_node)"
  cd "$ROOT_DIR"
  say "running in foreground on port $(read_port) (Ctrl+C to stop)"
  exec "$node" "$ROOT_DIR/server/index.js"
}

do_stop() {
  local pid
  if ! pid="$(running_pid)"; then
    rm -f "$PID_FILE"
    if systemd_active; then
      say "no pid file; the app is managed by systemd — use: systemctl --user stop ${SERVICE_UNIT}"
      return 0
    fi
    say "not running"
    return 0
  fi
  say "stopping pid ${pid}"
  kill -TERM "$pid" 2>/dev/null || true
  local i=0
  while pid_is_alive "$pid" && (( i < 100 )); do
    sleep 0.1
    i=$((i + 1))
  done
  if pid_is_alive "$pid"; then
    say "pid ${pid} ignored SIGTERM; sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  say "stopped"
}

do_status() {
  local port pid
  port="$(read_port)"
  if pid="$(running_pid)"; then
    say "running (pid ${pid}) on http://localhost:${port}"
    return 0
  fi
  if systemd_active; then
    say "running via systemd (${SERVICE_UNIT}) on http://localhost:${port}"
    return 0
  fi
  if port_answers "$port"; then
    say "port ${port} is answering, but no pid file or systemd unit owns it"
    return 0
  fi
  say "not running (port ${port} is free)"
  return 1
}

case "${1:-start}" in
  start)   do_start ;;
  run|foreground) do_run ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  -h|--help|help)
    sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown command '$1' (use start|run|stop|restart|status)" ;;
esac
