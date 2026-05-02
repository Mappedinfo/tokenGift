#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${ENV_FILE:-${1:-$REPO_DIR/.test.env}}"
NODE_CLI="$SCRIPT_DIR/tokengift.js"
PYTHON_CLI="$REPO_DIR/tokengift_cli/cli.py"
NODE_BIN="node"
PYTHON_BIN="python3"
KEY_BITS="${TOKENGIFT_KEY_BITS:-2048}"
STEP=0
TRACE_FILE=""
WORKDIR=""

info() {
  printf '[info] %s\n' "$*"
}

fail() {
  printf '[fail] %s\n' "$*"
}

pass() {
  printf '[pass] %s\n' "$*"
}

run_task() {
  local description="$1"
  shift

  local output_path=""
  if [ "${1:-}" = "--out" ]; then
    output_path="$2"
    shift 2
  fi

  STEP=$((STEP + 1))
  printf '\n[task %02d] %s\n' "$STEP" "$description"
  printf 'TASK=%02d %s\n' "$STEP" "$description" | tee -a "$TRACE_FILE"
  printf '[task-cmd]'
  local arg
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
  printf '[task-cmd]' | tee -a "$TRACE_FILE"
  printf ' %q' "$@" | tee -a "$TRACE_FILE"
  printf '\n' | tee -a "$TRACE_FILE"

  local stdout_tmp stderr_tmp status
  stdout_tmp="$(mktemp)"
  stderr_tmp="$(mktemp)"

  if "$@" >"$stdout_tmp" 2>"$stderr_tmp"; then
    status=0
  else
    status=$?
  fi

  if [ -n "$output_path" ]; then
    cp "$stdout_tmp" "$output_path"
  fi

  if [ -s "$stdout_tmp" ]; then
    cat "$stdout_tmp" | tee -a "$TRACE_FILE"
  fi
  if [ -s "$stderr_tmp" ]; then
    cat "$stderr_tmp" | tee -a "$TRACE_FILE" >&2
  fi

  printf '[task-result] exit_code=%s\n' "$status" | tee -a "$TRACE_FILE"

  rm -f "$stdout_tmp" "$stderr_tmp"
  if [ "$status" -ne 0 ]; then
    fail "任务失败：$description (exit_code=$status)"
    return "$status"
  fi
}

compare_files() {
  local label="$1"
  local expect_file="$2"
  local got_file="$3"

  local expect_sha
  local got_sha
  local expect_content
  local got_content

  expect_content="$(cat "$expect_file")"
  got_content="$(cat "$got_file")"
  expect_sha="$(printf '%s' "$expect_content" | shasum -a 256 | awk '{print $1}')"
  got_sha="$(printf '%s' "$got_content" | shasum -a 256 | awk '{print $1}')"

  if [ "$expect_content" = "$got_content" ]; then
    pass "$label"
    printf '[compare] %-30s | expect=%s | got=%s\n' "$label" "$expect_sha" "$got_sha" | tee -a "$TRACE_FILE"
    return 0
  fi

  fail "$label"
  printf '[compare] mismatch | expect=%s | got=%s\n' "$expect_sha" "$got_sha" | tee -a "$TRACE_FILE"
  echo '--- expected ---' | tee -a "$TRACE_FILE"
  cat "$expect_file" | tee -a "$TRACE_FILE"
  echo '--- got ---' | tee -a "$TRACE_FILE"
  cat "$got_file" | tee -a "$TRACE_FILE"
  return 1
}

preview() {
  local label="$1"
  local file="$2"
  local head_len=140
  printf '[preview] %-12s file=%s size=%s\n' "$label" "${file##*/}" "$(wc -c < "$file")" | tee -a "$TRACE_FILE"
  printf '[preview] %s\n' "$(head -c "$head_len" "$file")" | tee -a "$TRACE_FILE"
}

main() {
  if [ ! -f "$ENV_FILE" ]; then
    fail "找不到环境文件: $ENV_FILE"
    exit 2
  fi

  if [ ! -x "$NODE_CLI" ]; then
    fail "找不到可执行 node cli: $NODE_CLI"
    exit 2
  fi

  if [ ! -f "$PYTHON_CLI" ]; then
    fail "找不到 Python cli: $PYTHON_CLI"
    exit 2
  fi

  WORKDIR="$(mktemp -d)"
  trap 'rm -rf "$WORKDIR"' EXIT
  TRACE_FILE="$WORKDIR/tokengift-env-test.log"
  : > "$TRACE_FILE"

  info "开始 Tokengift .env 编码解码兼容测试"
  info "trace log: $TRACE_FILE"
  info "env file: $ENV_FILE"
  info "NODE_CLI: $NODE_CLI"
  info "PYTHON_CLI: $PYTHON_CLI"

  run_task "Node 运行时版本" "$NODE_BIN" --version
  run_task "npm 运行时版本" npm --version
  run_task "Python 运行时版本" "$PYTHON_BIN" --version
  run_task "Node CLI 帮助（含能力/参数）" "$NODE_BIN" "$NODE_CLI" --help
  run_task "Python CLI 帮助（含能力/参数）" "$PYTHON_BIN" "$PYTHON_CLI" --help

  local env_size
  local env_sha
  env_size="$(wc -c < "$ENV_FILE")"
  env_sha="$(shasum -a 256 "$ENV_FILE" | awk '{print $1}')"
  run_task "环境文件摘要" sh -c 'echo "file=$0"; echo "size=$1"; echo "sha256=$2"' "$ENV_FILE" "$env_size" "$env_sha"

  local public_key="$WORKDIR/tokengift.public.pem"
  local private_key="$WORKDIR/tokengift.private.pem"
  local node_payload="$WORKDIR/node.payload"
  local node_decoded="$WORKDIR/node.decoded"
  local python_payload="$WORKDIR/python.payload"
  local python_decoded="$WORKDIR/python.decoded"

  run_task "Node 生成 RSA 测试密钥对（bits=${KEY_BITS}）" "$NODE_BIN" "$NODE_CLI" keygen --public "$public_key" --private "$private_key" --bits "${KEY_BITS}"

  run_task "Node gift：加密 .test.env" --out "$node_payload" "$NODE_BIN" "$NODE_CLI" gift --public "$public_key" --in "$ENV_FILE"
  preview "node-payload" "$node_payload"

  run_task "Node open：解密 Node 密文" --out "$node_decoded" "$NODE_BIN" "$NODE_CLI" open --private "$private_key" --in "$node_payload"
  if ! compare_files "Node roundtrip" "$ENV_FILE" "$node_decoded"; then
    exit 1
  fi

  run_task "Python gift：加密 .test.env" --out "$python_payload" "$PYTHON_BIN" "$PYTHON_CLI" gift --public "$public_key" --in "$ENV_FILE"
  preview "python-payload" "$python_payload"

  run_task "Python open：解密 Python 密文" --out "$python_decoded" "$PYTHON_BIN" "$PYTHON_CLI" open --private "$private_key" --in "$python_payload"
  if ! compare_files "Python roundtrip" "$ENV_FILE" "$python_decoded"; then
    exit 1
  fi

  run_task "兼容性：Node 密文给 Python 解密" --out "$python_decoded" "$PYTHON_BIN" "$PYTHON_CLI" open --private "$private_key" --in "$node_payload"
  if ! compare_files "Node->Python compatibility" "$ENV_FILE" "$python_decoded"; then
    exit 1
  fi

  run_task "兼容性：Python 密文给 Node 解密" --out "$node_decoded" "$NODE_BIN" "$NODE_CLI" open --private "$private_key" --in "$python_payload"
  if ! compare_files "Python->Node compatibility" "$ENV_FILE" "$node_decoded"; then
    exit 1
  fi

  pass "Tokengift .env 兼容测试全部通过 ✅"
  info "执行日志: $TRACE_FILE"
  info "任务输出摘要:"
  cat "$TRACE_FILE"
}

main "$@"
