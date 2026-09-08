#!/bin/sh
# Run a command with this app's secrets.
# Deployed: Dokploy resolves its ${{vault.…}} references into the container env, so exec directly.
# Local: inject from the Infisical project bound by .infisical.json
#        (INFISICAL_ENV, default dev; INFISICAL_PATH selects a folder, default /).
set -eu
if [ -n "${LLM_API_KEY:-}${OPENROUTER_API_KEY:-}" ]; then
  exec "$@"
fi
exec infisical run --silent --env "${INFISICAL_ENV:-dev}" --path "${INFISICAL_PATH:-/}" -- "$@"
