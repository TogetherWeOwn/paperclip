#!/usr/bin/env bash
set -euo pipefail

# source-onboard-smoke.sh — Boot the checked-out source tree and drive the
# release onboarding smoke suite against it, without publishing anything.
#
# The fork's nightly lane selects a published canary by tag
# (release.yml:select_nightly), but the fork has published no canary since
# September 5, so tonight's smoke tests a 400-commit-old artifact against
# this week's contracts and fails every night. This harness instead boots the
# exact source under test — `onboard --yes` from this checkout via tsx, with
# the UI served from the same tree by the server's vite-dev middleware — then
# runs the unchanged release smoke Playwright suite against it.
#
# Requirements: a Linux host with pnpm dependencies installed. The server
# boots through tsx from source, so `cli/node_modules/tsx` must resolve and
# `ensure-plugin-build-deps` must be able to compile @paperclipai/shared and
# @paperclipai/plugin-sdk (typescript + @types/node [+ react] reachable).
# In CI that means `pnpm install --frozen-lockfile` first; the job does that.
#
# Provider access: the release suite drives the wizard's "Use API key
# instead" path and the server live-verifies the key against the hardcoded
# provider endpoint (see validateAiApiKey). Like docker-onboard-smoke.sh's
# provider mock, this harness answers api.anthropic.com from a local mock so
# the gate never depends on a real paid credential or provider uptime: the
# product is not touched — the mock binds loopback 443 and the server process
# resolves that one hostname to it through a hosts entry the harness manages,
# and the mock's self-signed certificate is trusted via NODE_EXTRA_CA_CERTS.
# What the gate proves is that this source can finish onboarding when the
# provider accepts the credential — the provider's actual verdict is not this
# source's code.
#
# Usage (CI drives every knob through env):
#   SOURCE_SMOKE_PORT=3232 \
#   DATA_DIR=$RUNNER_TEMP/source-smoke-data \
#   SMOKE_READY_TIMEOUT_SECONDS=420 \
#   SOURCE_SMOKE_METADATA_FILE=$RUNNER_TEMP/source-smoke.env \
#   SMOKE_LOG_FILE=$RUNNER_TEMP/source-onboard-smoke.log \
#   ./scripts/source-onboard-smoke.sh

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_PORT="${SOURCE_SMOKE_PORT:-3232}"
DATA_DIR="${DATA_DIR:-$REPO_ROOT/data/source-onboard-smoke}"
PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL:-http://127.0.0.1:${HOST_PORT}}"
SMOKE_READY_TIMEOUT_SECONDS="${SMOKE_READY_TIMEOUT_SECONDS:-420}"
SMOKE_METADATA_FILE="${SOURCE_SMOKE_METADATA_FILE:-}"
# Where the server's combined log is written. Kept even on success: it
# carries the boot SHA and the wizard trace the Playwright report points at.
SMOKE_LOG_FILE="${SMOKE_LOG_FILE:-${TMPDIR:-/tmp}/source-onboard-smoke.log}"
SMOKE_ADMIN_NAME="${SMOKE_ADMIN_NAME:-Smoke Admin}"
SMOKE_ADMIN_EMAIL="${SMOKE_ADMIN_EMAIL:-smoke-admin@paperclip.local}"
SMOKE_ADMIN_PASSWORD="${SMOKE_ADMIN_PASSWORD:-paperclip-smoke-password}"
# Mock the provider by default for the same reason the Docker harness does:
# a release gate must not depend on a real credential or provider uptime.
SMOKE_PROVIDER_MOCK="${SMOKE_PROVIDER_MOCK:-true}"
# Fixed before the run so diagnostics steps still know it on failure.
SOURCE_SMOKE_SERVER_LOG_NAME="${SOURCE_SMOKE_SERVER_LOG_NAME:-source-onboard-server.log}"
SERVER_PID=""
MOCK_PID=""
TMP_DIR=""
HOSTS_FILE="${SOURCE_SMOKE_HOSTS_FILE:-}"
HOSTS_TOUCHED="false"

mkdir -p "$DATA_DIR"
if [[ -n "$SMOKE_LOG_FILE" ]]; then
  mkdir -p "$(dirname "$SMOKE_LOG_FILE")" >/dev/null 2>&1 || true
  : >"$SMOKE_LOG_FILE" 2>/dev/null || true
fi

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" >/dev/null 2>&1 || true
  fi
  # The provider mock resolves through a hosts file the harness manages
  # (the container image's /etc/hosts in CI, a temp copy pointed at by
  # SOURCE_SMOKE_HOSTS_FILE elsewhere). Remove only the entry this script
  # added, never anything else in the file.
  if [[ "$HOSTS_TOUCHED" == "true" && -n "$HOSTS_FILE" ]]; then
    sed -i '/# paperclip-source-smoke-provider-mock$/d' "$HOSTS_FILE" 2>/dev/null || true
  fi
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Source smoke failed: required command '$1' not found" >&2
    exit 1
  }
}

require_cmd node
require_cmd openssl
require_cmd curl

# tsx ships with the CLI package (cli/package.json), so a full install puts
# its entry beside the CLI. Fall back to the pnpm store layout for partial
# installs; either path boots the same source tree.
TSX_CLI="$REPO_ROOT/cli/node_modules/tsx/dist/cli.mjs"
if [[ ! -f "$TSX_CLI" ]]; then
  TSX_CLI="$(ls -d "$REPO_ROOT"/node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs 2>/dev/null | head -1 || true)"
fi
if [[ -z "${TSX_CLI:-}" || ! -f "$TSX_CLI" ]]; then
  echo "Source smoke failed: tsx CLI not found (run pnpm install first)" >&2
  exit 1
fi

SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
echo "==> Source smoke candidate: $SOURCE_SHA"

# Pin the same build-stamp inputs a Docker image build receives, so the
# running server reports the exact source it was booted from: server-info
# falls back to PAPERCLIP_BUILD_COMMIT when git metadata is unavailable,
# and health always surfaces `commit`.
export PAPERCLIP_BUILD_COMMIT="$SOURCE_SHA"

write_metadata_file() {
  if [[ -z "$SMOKE_METADATA_FILE" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "$SMOKE_METADATA_FILE")"
  {
    printf 'SMOKE_BASE_URL=%q\n' "$PAPERCLIP_PUBLIC_URL"
    printf 'SMOKE_ADMIN_EMAIL=%q\n' "$SMOKE_ADMIN_EMAIL"
    printf 'SMOKE_ADMIN_PASSWORD=%q\n' "$SMOKE_ADMIN_PASSWORD"
    printf 'SMOKE_DATA_DIR=%q\n' "$DATA_DIR"
    printf 'SMOKE_SOURCE_SHA=%q\n' "$SOURCE_SHA"
    printf 'SMOKE_SERVER_PID=%q\n' "$SERVER_PID"
    printf 'SMOKE_LOG_FILE=%q\n' "$SMOKE_LOG_FILE"
  } >"$SMOKE_METADATA_FILE"
}

wait_for_http() {
  local url="$1"
  local attempts="${2:-60}"
  local sleep_seconds="${3:-1}"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -n "$SERVER_PID" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "Source smoke failed: server exited before $url became ready" >&2
      return 1
    fi
    sleep "$sleep_seconds"
  done
  echo "Source smoke failed: $url not ready after ${attempts} attempts" >&2
  return 1
}

start_provider_mock() {
  local mock_dir="$DATA_DIR-provider-mock"
  rm -rf "$mock_dir"
  mkdir -p "$mock_dir"
  chmod 755 "$mock_dir"

  # A self-signed leaf is its own trust anchor: presented by the mock and
  # listed in NODE_EXTRA_CA_CERTS, the one-certificate chain verifies and the
  # SAN satisfies hostname verification for api.anthropic.com.
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 7 \
    -keyout "$mock_dir/key.pem" \
    -out "$mock_dir/ca.pem" \
    -subj "/CN=api.anthropic.com" \
    -addext "subjectAltName=DNS:api.anthropic.com" >/dev/null 2>&1
  chmod 644 "$mock_dir/ca.pem"
  chmod 600 "$mock_dir/key.pem"

  # Only the one endpoint credential validation calls. Everything else 404s,
  # so an unexpected provider call fails the flow loudly instead of being
  # silently blessed by the mock.
  cat >"$mock_dir/server.mjs" <<'MOCK_EOF'
import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const server = createServer(
  {
    cert: readFileSync(process.env.MOCK_CERT),
    key: readFileSync(process.env.MOCK_KEY),
  },
  (req, res) => {
    const path = new URL(req.url, "https://api.anthropic.com").pathname;
    console.log(`[provider-mock] ${req.method} ${req.url}`);
    if (req.method === "GET" && path === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-sonnet-5", type: "model" }], has_more: false }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found_error", message: "provider mock: unexpected endpoint" } }));
  },
);
server.listen(443, "127.0.0.1", () => console.log("[provider-mock] listening on 127.0.0.1:443"));
MOCK_EOF

  # The mock must answer the provider's public hostname. It binds the
  # loopback 443 the product dials by name; only the one hostname resolves
  # there, and only for this run — removed in cleanup. The file defaults to
  # the container image's /etc/hosts (writable for root on GitHub runners);
  # local runs without that access point SOURCE_SMOKE_HOSTS_FILE at a temp
  # copy and run the server with a matching resolver override.
  if [[ -z "$HOSTS_FILE" ]]; then
    if [[ -w /etc/hosts ]]; then
      HOSTS_FILE=/etc/hosts
    else
      echo "Source smoke failed: /etc/hosts is not writable; set SOURCE_SMOKE_HOSTS_FILE to a writable hosts file" >&2
      return 1
    fi
  fi
  if ! grep -q "api.anthropic.com # paperclip-source-smoke-provider-mock$" "$HOSTS_FILE" 2>/dev/null; then
    echo "127.0.0.1 api.anthropic.com # paperclip-source-smoke-provider-mock" >>"$HOSTS_FILE"
    HOSTS_TOUCHED="true"
  fi

  MOCK_CERT="$mock_dir/ca.pem" MOCK_KEY="$mock_dir/key.pem" \
    node "$mock_dir/server.mjs" >>"$SMOKE_LOG_FILE" 2>&1 &
  MOCK_PID=$!

  for ((i = 1; i <= 30; i += 1)); do
    # Probe by IP with the hostname for TLS verification: the CI runner
    # resolves the name through the managed hosts file, but a local run with
    # SOURCE_SMOKE_HOSTS_FILE may not — the mock answers either way.
    if curl -fkss --resolve api.anthropic.com:443:127.0.0.1 https://api.anthropic.com/v1/models >/dev/null 2>&1; then
      echo "    Provider mock: api.anthropic.com -> 127.0.0.1 (mock pid $MOCK_PID)"
      return 0
    fi
    if ! kill -0 "$MOCK_PID" 2>/dev/null; then
      echo "Source smoke failed: provider mock exited before serving" >&2
      return 1
    fi
    sleep 1
  done
  echo "Source smoke failed: provider mock not ready after 30s" >&2
  return 1
}

if [[ "$SMOKE_PROVIDER_MOCK" == "true" ]]; then
  echo "==> Starting provider mock"
  start_provider_mock
  # Trust the mock's certificate for the server process only. Scoped to the
  # boot command's environment, never exported to the caller's shell.
  export NODE_EXTRA_CA_CERTS="$DATA_DIR-provider-mock/ca.pem"
fi

echo "==> Booting exact source $SOURCE_SHA"
echo "    Public URL: $PAPERCLIP_PUBLIC_URL"
echo "    Data dir: $DATA_DIR"
echo "    Server log: $SMOKE_LOG_FILE"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-source-onboard-smoke.XXXXXX")"
COOKIE_JAR="$TMP_DIR/cookies.txt"

# `onboard --yes --bind lan` persists authenticated/private reachability (the
# Docker harness's --bind lan equivalent) and then serves in the foreground,
# which keeps the exact source under test alive for the suite below.
PAPERCLIP_NO_BROWSER=1 \
PAPERCLIP_OPEN_ON_LISTEN=false \
PAPERCLIP_PUBLIC_URL="$PAPERCLIP_PUBLIC_URL" \
HOST=0.0.0.0 \
PORT="$HOST_PORT" \
  node "$TSX_CLI" "$REPO_ROOT/cli/src/index.ts" onboard --yes --bind lan --data-dir "$DATA_DIR" \
  >>"$SMOKE_LOG_FILE" 2>&1 &
SERVER_PID=$!

if ! wait_for_http "$PAPERCLIP_PUBLIC_URL/api/health" "$SMOKE_READY_TIMEOUT_SECONDS" 1; then
  exit 1
fi

COMMIT="$(curl -fsS "$PAPERCLIP_PUBLIC_URL/api/health" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{console.log(JSON.parse(s).commit??'')}catch{}})")"
if [[ "$COMMIT" != "$SOURCE_SHA" ]]; then
  echo "Source smoke failed: serving commit '${COMMIT:-<none>}' is not the booted source $SOURCE_SHA" >&2
  exit 1
fi
echo "    Serving commit verified: $COMMIT"

# Authenticated mode needs the same bootstrap the Docker harness performs:
# sign up (or sign in) the smoke admin, mint the CEO invite in-process, and
# accept it with a trusted browser origin.
sign_up_or_sign_in() {
  local response="$TMP_DIR/signup.json"
  local status
  status="$(curl -sS -o "$response" -w "%{http_code}" -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" -H "Origin: $PAPERCLIP_PUBLIC_URL" -X POST \
    "$PAPERCLIP_PUBLIC_URL/api/auth/sign-up/email" \
    --data "{\"name\":\"$SMOKE_ADMIN_NAME\",\"email\":\"$SMOKE_ADMIN_EMAIL\",\"password\":\"$SMOKE_ADMIN_PASSWORD\"}")"
  if [[ "$status" =~ ^2 ]]; then
    echo "    Smoke bootstrap: created admin user $SMOKE_ADMIN_EMAIL"
    return 0
  fi
  local signin_response="$TMP_DIR/signin.json"
  local signin_status
  signin_status="$(curl -sS -o "$signin_response" -w "%{http_code}" -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" -H "Origin: $PAPERCLIP_PUBLIC_URL" -X POST \
    "$PAPERCLIP_PUBLIC_URL/api/auth/sign-in/email" \
    --data "{\"email\":\"$SMOKE_ADMIN_EMAIL\",\"password\":\"$SMOKE_ADMIN_PASSWORD\"}")"
  if [[ "$signin_status" =~ ^2 ]]; then
    echo "    Smoke bootstrap: signed in existing admin user $SMOKE_ADMIN_EMAIL"
    return 0
  fi
  echo "Source smoke failed: could not sign up or sign in admin user" >&2
  cat "$response" >&2 || true
  cat "$signin_response" >&2 || true
  return 1
}

sign_up_or_sign_in

# The boot above already mints the first invite (onboard prints it when the
# fresh instance has no admin). Reuse it from the server log instead of
# minting a second one — bootstrap-ceo without --force prints no URL once an
# invite exists, which reads as a failure when it is actually success.
INVITE_URL="$(grep -o 'https\?://[^[:space:]]*/invite/pcp_bootstrap_[[:alnum:]]*' "$SMOKE_LOG_FILE" | tail -n 1 || true)"
if [[ -z "$INVITE_URL" ]]; then
  INVITE_URL="$(PAPERCLIP_HOME="$DATA_DIR" node "$TSX_CLI" "$REPO_ROOT/cli/src/index.ts" auth bootstrap-ceo --data-dir "$DATA_DIR" --base-url "$PAPERCLIP_PUBLIC_URL" 2>/dev/null \
    | grep -o 'https\?://[^[:space:]]*/invite/pcp_bootstrap_[[:alnum:]]*' | tail -n 1 || true)"
fi
if [[ -z "$INVITE_URL" ]]; then
  echo "Source smoke failed: bootstrap-ceo did not print an invite URL" >&2
  exit 1
fi
INVITE_TOKEN="${INVITE_URL##*/}"
ACCEPT_STATUS="$(curl -sS -o "$TMP_DIR/accept.json" -w "%{http_code}" -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -H "Content-Type: application/json" -H "Origin: $PAPERCLIP_PUBLIC_URL" -X POST \
  "$PAPERCLIP_PUBLIC_URL/api/invites/$INVITE_TOKEN/accept" \
  --data '{"requestType":"human"}')"
if [[ ! "$ACCEPT_STATUS" =~ ^2 ]]; then
  echo "Source smoke failed: bootstrap invite acceptance returned HTTP $ACCEPT_STATUS" >&2
  cat "$TMP_DIR/accept.json" >&2 || true
  exit 1
fi
echo "    Smoke bootstrap: accepted bootstrap invite"

SESSION="$(curl -fsS -c "$COOKIE_JAR" -b "$COOKIE_JAR" "$PAPERCLIP_PUBLIC_URL/api/auth/get-session")"
if [[ "$SESSION" != *'"userId"'* ]]; then
  echo "Source smoke failed: no authenticated session after bootstrap" >&2
  exit 1
fi

write_metadata_file

echo "==> Smoke server ready for automation"
echo "    Smoke base URL: $PAPERCLIP_PUBLIC_URL"
echo "    Smoke admin credentials: $SMOKE_ADMIN_EMAIL / $SMOKE_ADMIN_PASSWORD"
echo "    Smoke source SHA: $SOURCE_SHA"
if [[ -n "$SMOKE_METADATA_FILE" ]]; then
  echo "    Smoke metadata file: $SMOKE_METADATA_FILE"
fi

# Keep serving after this script exits: the workflow's Playwright step drives
# the suite next, and the workflow's final step stops the server by pid.
# Playwright signs in through the UI itself, so no cookie jar is exported.
#
# A background child of the script dies with the CI step (each `run:` step is
# its own process group, signalled on completion), so the server must leave
# the group to survive. setsid reparents it to init; the EXIT trap is removed
# first so it cannot kill what was just detached. The relaunched server
# inherits every boot variable through the preserved environment below — the
# port/host/public-URL trio, the data dir, the mock trust anchor, and the
# exact-source build stamp — so it serves the same verified source.
# Stdio stays on the log file, never the step.
if [[ "${SMOKE_DETACH:-true}" == "true" ]]; then
  trap - EXIT INT TERM
  setsid env \
    "PAPERCLIP_NO_BROWSER=1" \
    "PAPERCLIP_OPEN_ON_LISTEN=false" \
    "PAPERCLIP_PUBLIC_URL=$PAPERCLIP_PUBLIC_URL" \
    "PAPERCLIP_BUILD_COMMIT=$SOURCE_SHA" \
    "NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-}" \
    "HOST=0.0.0.0" \
    "PORT=$HOST_PORT" \
    node "$TSX_CLI" "$REPO_ROOT/cli/src/index.ts" onboard --yes --bind lan --data-dir "$DATA_DIR" \
    >>"$SMOKE_LOG_FILE" 2>&1 < /dev/null &
  DETACHED_PID=$!
  sleep 2
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  SERVER_PID="$DETACHED_PID"
  if ! wait_for_http "$PAPERCLIP_PUBLIC_URL/api/health" 60 1; then
    exit 1
  fi
  COMMIT="$(curl -fsS "$PAPERCLIP_PUBLIC_URL/api/health" | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{console.log(JSON.parse(s).commit??'')}catch{}})")"
  if [[ "$COMMIT" != "$SOURCE_SHA" ]]; then
    echo "Source smoke failed: detached server commit '${COMMIT:-<none>}' is not the booted source $SOURCE_SHA" >&2
    exit 1
  fi
  write_metadata_file
  echo "    Smoke server detached and re-verified: $COMMIT"
else
  wait "$SERVER_PID"
fi
