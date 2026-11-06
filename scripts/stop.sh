#!/usr/bin/env bash
#
# poca-note — stop the app.
#
# Stops a background instance started by scripts/start.sh. When the app is
# supervised by the systemd user unit, this tells you the right command instead
# of leaving the service to restart it behind your back.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT_DIR/scripts/start.sh" stop
