#!/bin/zsh

set -euo pipefail

readonly keychain_account="$(/usr/bin/id -un)"
readonly node_bin="/Users/johnlesterescarlan/.nvm/versions/node/v24.15.0/bin/node"
readonly runner_script="/Users/johnlesterescarlan/.nvm/versions/node/v24.15.0/lib/node_modules/n8n/node_modules/@n8n/task-runner/dist/start.js"
readonly broker_uri="http://127.0.0.1:5679"

export PATH="/Users/johnlesterescarlan/.nvm/versions/node/v24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export GENERIC_TIMEZONE="Asia/Manila"
export N8N_RUNNERS_TASK_BROKER_URI="${broker_uri}"
export N8N_RUNNERS_MAX_CONCURRENCY="3"
export N8N_RUNNERS_TASK_TIMEOUT="300"
export N8N_RUNNERS_HEARTBEAT_INTERVAL="15"

readonly auth_token="$(/usr/bin/security find-generic-password -a "${keychain_account}" -s "io.codex.job-pipeline.runners-auth-token" -w)"
if [[ -z "${auth_token}" || ! -f "${runner_script}" ]]; then
  print -u2 "Job Pipeline runner startup failed: required runner configuration is unavailable."
  exit 1
fi

for attempt in {1..120}; do
  if /usr/bin/curl --silent --fail --max-time 2 "${broker_uri}/healthz" >/dev/null; then
    break
  fi
  if (( attempt == 120 )); then
    print -u2 "Job Pipeline runner startup failed: task broker did not become healthy."
    exit 1
  fi
  /bin/sleep 1
done

readonly grant_token="$(
  /usr/bin/printf '{"token":"%s"}' "${auth_token}" |
    /usr/bin/curl --silent --show-error --fail --max-time 10 \
      --header 'Content-Type: application/json' \
      --data-binary @- \
      "${broker_uri}/runners/auth" |
    "${node_bin}" -e 'let body=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => { const token = JSON.parse(body).data?.token; if (typeof token !== "string" || !token) process.exit(1); process.stdout.write(token); });'
)"

if [[ -z "${grant_token}" ]]; then
  print -u2 "Job Pipeline runner startup failed: no grant token was issued."
  exit 1
fi

export N8N_RUNNERS_GRANT_TOKEN="${grant_token}"
exec "${node_bin}" --disallow-code-generation-from-strings --disable-proto=delete "${runner_script}"
