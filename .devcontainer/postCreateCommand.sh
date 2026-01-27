#!/usr/bin/env bash
set -euo pipefail

if [ ! -d ../agent-context-graph-foundations ]; then
  git clone https://github.com/markjspivey-xwisee/agent-context-graph-foundations ../agent-context-graph-foundations
fi

npm install
