#!/usr/bin/env bash
set -euo pipefail

PACKAGE="@tangle-network/traces"
VERSION="${TRACES_VERSION:-latest}"
PREFIX="${TRACES_PREFIX:-}"

usage() {
  cat <<'USAGE'
Install the traces CLI from npm.

Usage:
  curl -fsSL https://raw.githubusercontent.com/tangle-network/traces/main/install.sh | bash
  ./install.sh [--version <version>] [--prefix <dir>]

Environment:
  TRACES_VERSION   npm version or tag to install (default: latest)
  TRACES_PREFIX    npm global prefix to use when the default is not writable
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "${2:-}" ] || { echo "missing value for --version" >&2; exit 2; }
      VERSION="$2"
      shift 2
      ;;
    --prefix)
      [ "${2:-}" ] || { echo "missing value for --prefix" >&2; exit 2; }
      PREFIX="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >=22 is required before installing traces." >&2
  exit 1
fi

node_version="$(node -e "process.stdout.write(process.versions.node)")"
node_major="${node_version%%.*}"
if [ "$node_major" -lt 22 ]; then
  echo "Node.js >=22 is required; found v$node_version." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required before installing traces." >&2
  exit 1
fi

install_args=(install -g "${PACKAGE}@${VERSION}")
npm_prefix="$(npm prefix -g)"
install_prefix="$npm_prefix"

if [ -n "$PREFIX" ]; then
  mkdir -p "$PREFIX"
  install_args+=(--prefix "$PREFIX")
  install_prefix="$PREFIX"
else
  if [ ! -w "$npm_prefix" ]; then
    install_prefix="$HOME/.local"
    mkdir -p "$install_prefix"
    install_args+=(--prefix "$install_prefix")
    echo "npm global prefix is not writable; installing into $install_prefix"
  fi
fi

npm "${install_args[@]}"

bin_dir="$install_prefix/bin"
if [ -x "$bin_dir/traces" ]; then
  traces_cmd="$bin_dir/traces"
elif command -v traces >/dev/null 2>&1; then
  traces_cmd="traces"
else
  echo "Installed ${PACKAGE}@${VERSION}, but the traces binary was not found at $bin_dir/traces or on PATH." >&2
  echo "Add this to PATH: $bin_dir" >&2
  exit 1
fi

version_output="$("$traces_cmd" --version 2>/dev/null || true)"
case "$version_output" in
  traces\ [0-9]*.[0-9]*.[0-9]*) echo "$version_output" ;;
  *) echo "traces installed: $traces_cmd" ;;
esac
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "Add this to PATH for future shells: $bin_dir" ;;
esac
echo "Run: traces analyze --harness claude-code --last 1"
