#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$ROOT_DIR"
PYPROJECT_FILE="$PROJECT_ROOT/pyproject.toml"
DIST_DIR="$PROJECT_ROOT/dist"
ENV_FILE="${ENV_FILE:-$PROJECT_ROOT/.env}"
RELEASE_LEVEL="${1:-patch}"

print_help() {
  cat <<'EOF'
Usage:
  scripts/publish_pypi_uv.sh [patch|minor|major]

Environment:
  ENV_FILE         .env 文件路径，默认: ./.env
  PYPI_PROJECT_NAME  校验 pyproject.toml name（可选）
  TWINE_USERNAME     登录用户名（推荐: __token__）
  TWINE_PASSWORD     登录密码（推荐使用 API token）
  PYPI_API_TOKEN     可自动映射为 TWINE_PASSWORD（可选）
  UV_PYTHON          uv 指定 python 解释器（可选）
  UV_CACHE_DIR       uv 缓存目录（可选）
EOF
}

if [[ "$RELEASE_LEVEL" != "patch" && "$RELEASE_LEVEL" != "minor" && "$RELEASE_LEVEL" != "major" ]]; then
  print_help
  echo "[publish_pypi_uv] 版本类型必须是 patch / minor / major"
  exit 1
fi

if [[ ! -f "$PYPROJECT_FILE" ]]; then
  echo "[publish_pypi_uv] 未找到 pyproject.toml: $PYPROJECT_FILE" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "[publish_pypi_uv] 未检测到 uv，请先安装 uv" >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  read_dotenv() {
    local file="$1"
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%%#*}"
      line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      [[ -z "$line" ]] && continue
      line="$(printf '%s' "$line" | sed 's/^export[[:space:]]*//')"
      if [[ "$line" == *=* ]]; then
        local key="${line%%=*}"
        local value="${line#*=}"
        key="$(printf '%s' "$key" | sed 's/[[:space:]]//g')"
        value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
        value="${value%\"}"; value="${value#\"}"
        value="${value%\'}"; value="${value#\'}"
        if [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
          export "$key"="$value"
        fi
      fi
    done < "$file"
  }

  read_dotenv "$ENV_FILE"
  echo "[publish_pypi_uv] 已加载 env 文件: $ENV_FILE"
fi

if [[ -z "${TWINE_USERNAME:-}" && -n "${PYPI_API_TOKEN:-}" ]]; then
  TWINE_USERNAME="__token__"
fi

if [[ -z "${TWINE_PASSWORD:-}" && -n "${PYPI_API_TOKEN:-}" ]]; then
  TWINE_PASSWORD="$PYPI_API_TOKEN"
fi

if [[ -z "${TWINE_USERNAME:-}" || -z "${TWINE_PASSWORD:-}" ]]; then
  echo "[publish_pypi_uv] 请设置 TWINE_USERNAME 与 TWINE_PASSWORD（或在 .env 中设置 PYPI_API_TOKEN）" >&2
  exit 1
fi

if [[ -n "${PYPI_PROJECT_NAME:-}" ]]; then
  PYPI_NAME_IN_PROJECT=$(PYPROJECT_PATH="$PYPROJECT_FILE" uv run python - <<'PY'
import re
from pathlib import Path
import os
p = Path(os.environ["PYPROJECT_PATH"])
m = re.search(r'^name\s*=\s*"([^"]+)"', p.read_text(encoding="utf-8"), re.M)
print(m.group(1) if m else "")
PY
)
  if [[ "$PYPI_NAME_IN_PROJECT" != "$PYPI_PROJECT_NAME" ]]; then
    echo "[publish_pypi_uv] pyproject.toml name=$PYPI_NAME_IN_PROJECT，不匹配期望=$PYPI_PROJECT_NAME"
    echo "[publish_pypi_uv] 如需继续请先修改 pyproject.toml 的 [project] name 或调整 PYPI_PROJECT_NAME"
    exit 1
  fi
fi

read -r CURRENT_NAME CURRENT_VERSION < <(PYPROJECT_PATH="$PYPROJECT_FILE" uv run python - <<'PY'
import re
from pathlib import Path
import os
text = Path(os.environ["PYPROJECT_PATH"]).read_text(encoding="utf-8")
name_m = re.search(r'^name\s*=\s*"([^"]+)"', text, re.M)
ver_m = re.search(r'^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"', text, re.M)
if not name_m or not ver_m:
    raise SystemExit("Cannot parse name/version in pyproject.toml")
print(name_m.group(1), ver_m.group(1))
PY
)

bump_version() {
  local current=$1
  local level=$2
  local major minor patch
  IFS='.' read -r major minor patch <<<"$current"
  case "$level" in
    patch) patch=$((patch + 1)) ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    major) major=$((major + 1)); minor=0; patch=0 ;;
  esac
  echo "$major.$minor.$patch"
}

NEW_VERSION=$(bump_version "$CURRENT_VERSION" "$RELEASE_LEVEL")

uv run python - <<PY
from pathlib import Path
p = Path("$PYPROJECT_FILE")
text = p.read_text(encoding="utf-8")
old = "version = \"$CURRENT_VERSION\""
new = f"version = \"$NEW_VERSION\""
if old not in text:
    raise SystemExit("Cannot find old version string")
p.write_text(text.replace(old, new, 1), encoding="utf-8")
print(f"[publish_pypi_uv] 版本已更新: {old} -> {new}")
PY

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

UV_RUN=(uv run)
if [[ -n "${UV_PYTHON:-}" ]]; then
  UV_RUN+=(--python "$UV_PYTHON")
fi

cd "$PROJECT_ROOT"
echo "[publish_pypi_uv] 先运行 build（uv run --with build python -m build）"
"${UV_RUN[@]}" --with build --with twine python -m build

echo "[publish_pypi_uv] 上传 PyPI（twine upload dist/*）"
"${UV_RUN[@]}" --with twine python -m twine upload "$DIST_DIR"/*

echo "[publish_pypi_uv] 发布完成: $CURRENT_NAME@$NEW_VERSION"

echo "[publish_pypi_uv] 发布地址: https://pypi.org/project/$CURRENT_NAME/$NEW_VERSION/"
