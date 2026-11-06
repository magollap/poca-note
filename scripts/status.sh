#!/usr/bin/env bash
#
# poca-note — report whether the app is running.
#
# Exit codes: 0 = running (pid file, systemd unit, or the port answers),
#             1 = not running.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT_DIR/scripts/start.sh" status
