#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FOUNDATIONS_DIR="${ROOT_DIR}/../agent-context-graph-foundations"
BACKEND="${1:-}"

is_sourced=false
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  is_sourced=true
fi

if [[ ! -d "${FOUNDATIONS_DIR}/.git" ]]; then
  echo "Cloning foundations repo..."
  git clone https://github.com/markjspivey-xwisee/agent-context-graph-foundations "${FOUNDATIONS_DIR}"
else
  if [[ -z "$(git -C "${FOUNDATIONS_DIR}" status --porcelain)" ]]; then
    echo "Updating foundations repo..."
    git -C "${FOUNDATIONS_DIR}" pull --ff-only || true
  else
    echo "Foundations repo has local changes; skipping pull."
  fi
fi

export ACG_SPEC_DIR="${FOUNDATIONS_DIR}/spec"

if [[ -n "${BACKEND}" ]]; then
  export REASONING_BACKEND="${BACKEND}"
fi

echo "Installing npm dependencies..."
cd "${ROOT_DIR}"
npm install

echo ""
echo "Ready."
echo "ACG_SPEC_DIR=${ACG_SPEC_DIR}"
if [[ -n "${BACKEND}" ]]; then
  echo "REASONING_BACKEND=${REASONING_BACKEND}"
else
  echo "REASONING_BACKEND not set (defaults to anthropic)."
fi
echo ""
echo "Next steps:"
echo "  npm run dev"
echo "  npm run dashboard"
echo ""
if [[ "${is_sourced}" == "false" ]]; then
  echo "Tip: run 'source scripts/codespaces-start.sh <backend>' to persist env vars in your shell."
fi
