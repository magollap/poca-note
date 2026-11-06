#!/usr/bin/env bash
#
# poca-note installer for macOS and Linux.
#
#   ./scripts/install.sh              install dependencies and build the UI
#   ./scripts/install.sh --dev        set up for development (no production build)
#   ./scripts/install.sh --start      install, then start the app
#   ./scripts/install.sh --test       install, then run the test suite
#   ./scripts/install.sh --help       show every option
#
# The script reads requirements.txt, checks Node.js/npm, installs the npm
# packages, creates .env and data/, and builds web/dist. It never edits your
# .env or deletes data.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUIREMENTS="$ROOT/requirements.txt"

DEV=0
SKIP_INSTALL=0
SKIP_BUILD=0
SKIP_ENV=0
START=0
RUN_TESTS=0
FORCE=0
INSTALL_NODE=0

usage() {
  cat <<'EOF'
poca-note installer (macOS / Linux)

Usage:
  ./scripts/install.sh [options]

Options:
  --dev            Set up for development and skip the production build
  --start          Start the app after installing
  --test           Run the test suite after installing
  --install-node   Try to install Node.js with the local package manager
  --skip-install   Do not run npm ci / npm install
  --skip-build     Do not build web/dist
  --skip-env       Do not create .env from .env.example
  --force          Reinstall dependencies with npm ci
  -h, --help       Show this help

Examples:
  ./scripts/install.sh
  ./scripts/install.sh --dev --start
  ./scripts/install.sh --install-node --start
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) DEV=1 ;;
    --start) START=1 ;;
    --test) RUN_TESTS=1 ;;
    --install-node) INSTALL_NODE=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --skip-env) SKIP_ENV=1 ;;
    --force) FORCE=1 ;;
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

# Compare dotted numeric versions without relying on GNU sort -V.
version_ge() {
  local actual="$1" required="$2"
  local IFS=.
  local -a a b
  read -r -a a <<< "$actual"
  read -r -a b <<< "$required"
  local i max=${#a[@]}
  (( ${#b[@]} > max )) && max=${#b[@]}
  for ((i = 0; i < max; i++)); do
    local x="${a[i]:-0}" y="${b[i]:-0}"
    x=$((10#$x))
    y=$((10#$y))
    if (( x > y )); then return 0; fi
    if (( x < y )); then return 1; fi
  done
  return 0
}

version_ok() {
  local actual="$1" op="$2" required="$3"
  case "$op" in
    ">=") version_ge "$actual" "$required" ;;
    ">") ! version_ge "$required" "$actual" ;;
    "<=") version_ge "$required" "$actual" ;;
    "<") ! version_ge "$actual" "$required" ;;
    "=") version_ge "$actual" "$required" && version_ge "$required" "$actual" ;;
    *) return 1 ;;
  esac
}

cmd_version() {
  local cmd="$1"
  "$cmd" --version 2>/dev/null | head -n1 | tr -d '[:space:]' | sed -E 's/^[vV]//'
}

check_requirements() {
  local failed=0
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    local line="${raw%%#*}"
    line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [[ -z "$line" ]] && continue

    local kind="${line%%:*}"
    local rest="${line#*:}"
    rest="$(printf '%s' "$rest" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"

    case "$kind" in
      require)
        local name="${rest%% *}"
        local spec="${rest#* }"
        [[ "$spec" == "$rest" ]] && spec=">=0"

        local op=">=" want="$spec"
        if [[ "$spec" =~ ^([\<\>=]+)[[:space:]]*(.+)$ ]]; then
          op="${BASH_REMATCH[1]}"
          want="${BASH_REMATCH[2]}"
        fi

        if ! command -v "$name" >/dev/null 2>&1; then
          err "$name is not installed (need $op$want)."
          failed=1
          continue
        fi

        local actual
        actual="$(cmd_version "$name")"
        if [[ -z "$actual" ]]; then
          err "Could not determine $name version."
          failed=1
        elif version_ok "$actual" "$op" "$want"; then
          ok "$name $actual (need $op$want)"
        else
          err "$name $actual is too old (need $op$want)."
          failed=1
        fi
        ;;
      optional)
        local name="${rest%% *}"
        if command -v "$name" >/dev/null 2>&1; then
          ok "$name $(cmd_version "$name") (optional)"
        else
          warn "$name not found (optional; SQLite is the default)."
        fi
        ;;
    esac
  done < "$REQUIREMENTS"
  return "$failed"
}

verify_npm_packages() {
  local missing=()
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    local line="${raw%%#*}"
    line="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [[ -z "$line" ]] && continue
    [[ "$line" == npm:* ]] || continue

    local rest="${line#npm:}"
    local pkg="${rest%% *}"
    if [[ ! -f "$ROOT/node_modules/$pkg/package.json" ]]; then
      missing+=("$pkg")
    fi
  done < "$REQUIREMENTS"

  if (( ${#missing[@]} > 0 )); then
    err "Missing npm packages: ${missing[*]}"
    return 1
  fi
  ok "All npm packages from requirements.txt are present."
}

install_node() {
  local os
  os="$(uname -s)"
  local sudo_cmd=""
  if [[ ${EUID:-$(id -u)} -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
    sudo_cmd="sudo"
  fi

  as_root() {
    if [[ -n "$sudo_cmd" ]]; then
      "$sudo_cmd" "$@"
    else
      "$@"
    fi
  }

  case "$os" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        info "Installing Node.js with Homebrew..."
        brew install node
      else
        err "Install Homebrew (https://brew.sh) or Node.js 22.13+ from https://nodejs.org/."
        return 1
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then
        if ! command -v curl >/dev/null 2>&1; then
          err "curl is required for the NodeSource installer."
          return 1
        fi
        info "Installing Node.js 22 with NodeSource..."
        if [[ -n "$sudo_cmd" ]]; then
          curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        else
          curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        fi
        as_root apt-get install -y nodejs
      elif command -v dnf >/dev/null 2>&1; then
        info "Installing Node.js with dnf..."
        as_root dnf install -y nodejs npm
      elif command -v pacman >/dev/null 2>&1; then
        info "Installing Node.js with pacman..."
        as_root pacman -S --needed --noconfirm nodejs npm
      else
        err "Install Node.js 22.13+ from https://nodejs.org/."
        return 1
      fi
      ;;
    *)
      err "Unsupported OS: $os. Install Node.js 22.13+ manually."
      return 1
      ;;
  esac
  command -v node >/dev/null 2>&1
}

info "poca-note installer"
info "Project: $ROOT"

if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
  warn "You are running as root. Prefer your normal user so node_modules and data stay writable by you."
  warn "If you already ran this with sudo, fix ownership: sudo chown -R \$USER:\$USER \"$ROOT\""
fi

if [[ ! -f "$REQUIREMENTS" ]]; then
  err "requirements.txt not found at $REQUIREMENTS"
  exit 1
fi

info "Checking system requirements..."
if ! check_requirements; then
  if (( INSTALL_NODE )); then
    info "Attempting to install Node.js..."
    if install_node; then
      info "Re-checking requirements..."
      if ! check_requirements; then
        err "Requirements are still missing."
        exit 1
      fi
    else
      err "Automatic Node.js installation failed."
      exit 1
    fi
  else
    err "Install the missing requirements and re-run this script."
    err "Tip: use --install-node to let the script install Node.js where supported."
    exit 1
  fi
fi

if (( SKIP_INSTALL )); then
  warn "Skipping dependency installation."
else
  cd "$ROOT"
  if [[ -f package-lock.json ]] && { [[ ! -d node_modules ]] || (( FORCE )); }; then
    info "Installing npm dependencies with npm ci..."
    if ! npm ci --no-audit --no-fund; then
      warn "npm ci failed; falling back to npm install."
      npm install --no-audit --no-fund
    fi
  else
    info "Installing npm dependencies with npm install..."
    npm install --no-audit --no-fund
  fi
  verify_npm_packages
fi

if (( SKIP_ENV )); then
  warn "Skipping .env setup."
elif [[ ! -f "$ROOT/.env" && -f "$ROOT/.env.example" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  ok "Created .env from .env.example."
elif [[ -f "$ROOT/.env" ]]; then
  ok ".env already exists; leaving it untouched."
fi

mkdir -p "$ROOT/data"

if (( DEV )); then
  warn "Dev mode: skipping the production build."
elif (( SKIP_BUILD )); then
  warn "Skipping the production build."
else
  info "Building the web UI..."
  ( cd "$ROOT" && npm run build )
  ok "Web UI built into web/dist."
fi

if [[ ! -f "$ROOT/web/dist/index.html" ]]; then
  warn "web/dist/index.html is missing. Run 'npm run build' before 'npm start'."
fi

if (( RUN_TESTS )); then
  info "Running tests..."
  ( cd "$ROOT" && npm test )
fi

if (( START )); then
  cd "$ROOT"
  if (( DEV )); then
    info "Starting development servers (API :8787, Vite :5173)..."
    exec npm run dev
  else
    info "Starting poca-note in production mode..."
    exec npm start
  fi
fi

echo
ok "Installation complete."
echo
warn "The app is NOT running yet. Nothing is listening on the port until you start it."
echo
if (( DEV )); then
  echo "  Start development:  npm run dev"
  echo "  Then open:          http://localhost:5173"
else
  echo "  Start production:   npm start"
  echo "  Then open:          http://localhost:8787"
fi
echo
echo "  Start it automatically next time:  ./scripts/install.sh --start"
echo "  Demo login:         acme / poca-demo (only on a fresh database)"
echo "  Configuration:      .env"
echo "  Keep the server terminal open; press Ctrl+C to stop."
echo "  From another machine: http://<server-ip>:8787 (allow the port in your firewall)."
