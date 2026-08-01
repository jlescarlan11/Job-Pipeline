#!/bin/zsh

set -euo pipefail

readonly keychain_account="$(/usr/bin/id -un)"
readonly n8n_bin="/Users/johnlesterescarlan/.nvm/versions/node/v24.15.0/bin/n8n"

export PATH="/Users/johnlesterescarlan/.nvm/versions/node/v24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export N8N_BLOCK_ENV_ACCESS_IN_NODE="false"
export GENERIC_TIMEZONE="Asia/Manila"
export EXECUTIONS_TIMEOUT="900"
export EXECUTIONS_TIMEOUT_MAX="900"
export EXECUTIONS_DATA_SAVE_ON_ERROR="all"
export EXECUTIONS_DATA_SAVE_ON_SUCCESS="none"
export EXECUTIONS_DATA_SAVE_ON_PROGRESS="false"
export EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS="true"
export EXECUTIONS_DATA_PRUNE="true"
export EXECUTIONS_DATA_MAX_AGE="336"
export EXECUTIONS_DATA_PRUNE_MAX_COUNT="10000"
export EXECUTIONS_DATA_HARD_DELETE_BUFFER="1"
export N8N_CONCURRENCY_PRODUCTION_LIMIT="3"
export N8N_RUNNERS_MODE="external"
export N8N_RUNNERS_MAX_CONCURRENCY="3"
export N8N_RUNNERS_TASK_TIMEOUT="300"
export N8N_RUNNERS_TASK_REQUEST_TIMEOUT="60"
export N8N_RUNNERS_HEARTBEAT_INTERVAL="15"
export N8N_RUNNERS_AUTH_TOKEN="$(/usr/bin/security find-generic-password -a "${keychain_account}" -s "io.codex.job-pipeline.runners-auth-token" -w)"
export N8N_HTTP_RESPONSE_BODY_READ_TIMEOUT="20000"
export N8N_METRICS="true"
export N8N_METRICS_INCLUDE_DEFAULT_METRICS="true"
export N8N_METRICS_INCLUDE_WORKFLOW_ID_LABEL="true"
export N8N_METRICS_INCLUDE_QUEUE_METRICS="false"
export JOB_PIPELINE_SPREADSHEET_ID="$(/usr/bin/security find-generic-password -a "${keychain_account}" -s "io.codex.job-pipeline.spreadsheet-id" -w)"
export JOB_PIPELINE_CONFIG_SPREADSHEET_ID="$(/usr/bin/security find-generic-password -a "${keychain_account}" -s "io.codex.job-pipeline.config-spreadsheet-id" -w)"
export JOB_PIPELINE_OLD_SPREADSHEET_ID="$(/usr/bin/security find-generic-password -a "${keychain_account}" -s "io.codex.job-pipeline.old-spreadsheet-id" -w)"
export JOB_PIPELINE_REVIEW_URL="$(/usr/bin/security find-generic-password -a "${keychain_account}" -s "io.codex.job-pipeline.review-url" -w)"
export JOB_PIPELINE_GROQ_API_KEY="$(/usr/bin/security find-generic-password -a "${keychain_account}" -s "io.codex.job-pipeline.groq-api-key" -w)"
export JOB_PIPELINE_SLACK_WEBHOOK_URL="$(/usr/bin/security find-generic-password -a "${keychain_account}" -s "io.codex.job-pipeline.slack-webhook" -w)"

if [[
  -z "${JOB_PIPELINE_SPREADSHEET_ID}" ||
  -z "${JOB_PIPELINE_CONFIG_SPREADSHEET_ID}" ||
  -z "${JOB_PIPELINE_OLD_SPREADSHEET_ID}" ||
  -z "${JOB_PIPELINE_REVIEW_URL}" ||
  -z "${JOB_PIPELINE_GROQ_API_KEY}" ||
  -z "${JOB_PIPELINE_SLACK_WEBHOOK_URL}" ||
  -z "${N8N_RUNNERS_AUTH_TOKEN}"
]]; then
  print -u2 "Job Pipeline startup failed: required production configuration is unavailable."
  exit 1
fi

exec "${n8n_bin}" start
