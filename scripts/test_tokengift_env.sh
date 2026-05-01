#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${1:-$REPO_DIR/.env}"
NODE_CLI="$SCRIPT_DIR/tokengift.js"
PYTHON_CLI="$REPO_DIR/tokengift_cli/cli.py"
KEY_BITS="${TOKENGIFT_KEY_BITS:-2048}"

info() {
  printf '[info] %s\n' "$*"
}

fail() {
  printf '[fail] %s\n' "$*"
}

pass() {
  printf '[pass] %s\n' "$*"
}

compare_files() {
  local label="$1"
  local expect_file="$2"
  local got_file="$3"

  local expect_content
  local got_content
  expect_content="$(cat "$expect_file")"
  got_content="$(cat "$got_file")"

  if [ "$expect_content" = "$got_content" ]; then
    pass "$label"
    return 0
  else
    fail "$label"
    echo "expected:"
    cat "$expect_file"
    echo "got:"
    cat "$got_file"
    return 1
  fi
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

  local workdir
  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' EXIT

  local public_key="$workdir/tokengift.public.pem"
  local private_key="$workdir/tokengift.private.pem"
  local node_payload="$workdir/node.payload"
  local node_decoded="$workdir/node.decoded"
  local python_payload="$workdir/python.payload"
  local python_decoded="$workdir/python.decoded"

  info "生成 2048-bit RSA 测试密钥对（可通过 TOKENGIFT_KEY_BITS 调整）"
  node "$NODE_CLI" keygen --public "$public_key" --private "$private_key" --bits "$KEY_BITS"

  info "Node 加密后解密"
  node "$NODE_CLI" gift --public "$public_key" --in "$ENV_FILE" > "$node_payload"
  node "$NODE_CLI" open --private "$private_key" --in "$node_payload" > "$node_decoded"
  if ! compare_files "Node roundtrip" "$ENV_FILE" "$node_decoded"; then
    exit 1
  fi

  info "Python 加密后解密"
  python3 "$PYTHON_CLI" gift --public "$public_key" --in "$ENV_FILE" > "$python_payload"
  python3 "$PYTHON_CLI" open --private "$private_key" --in "$python_payload" > "$python_decoded"
  if ! compare_files "Python roundtrip" "$ENV_FILE" "$python_decoded"; then
    exit 1
  fi

  info "Node 加密结果用 Python 解密"
  python3 "$PYTHON_CLI" open --private "$private_key" --in "$node_payload" > "$python_decoded"
  if ! compare_files "Node->Python compatibility" "$ENV_FILE" "$python_decoded"; then
    exit 1
  fi

  info "Python 加密结果用 Node 解密"
  node "$NODE_CLI" open --private "$private_key" --in "$python_payload" > "$node_decoded"
  if ! compare_files "Python->Node compatibility" "$ENV_FILE" "$node_decoded"; then
    exit 1
  fi

  pass "Tokengift .env 兼容测试全部通过 ✅"
  info "测试文件：$ENV_FILE"
  info "payload:"
  info "  Node payload: $node_payload"
  info "  Python payload: $python_payload"
}

main "$@"
