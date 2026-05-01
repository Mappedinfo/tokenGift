#!/usr/bin/env bash
set -euo pipefail

LEVEL="${1:-patch}"
PYPROJECT="pyproject.toml"
DIST_DIR="dist"
PYTHON_BIN="${PYTHON_BIN:-python3}"
UV_BIN="${UV_BIN:-uv}"
UV_PYTHON="${UV_PYTHON:-}"
USE_UV=0

if [[ ! -f "$PYPROJECT" ]]; then
  echo "[release_py] 未找到 $PYPROJECT" >&2
  exit 1
fi

if command -v "$UV_BIN" >/dev/null 2>&1; then
  USE_UV=1
  echo "[release_py] 检测到 uv，将优先使用 uv 运行 build/twine" 
else
  echo "[release_py] 未检测到 uv，回退到 python3 环境执行"
fi

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${TWINE_USERNAME:-}" || -z "${TWINE_PASSWORD:-}" ]]; then
  echo "[release_py] 未检测到 TWINE_USERNAME 或 TWINE_PASSWORD（请设置环境变量或 .env 文件）" >&2
  exit 1
fi

current_version=$("${PYTHON_BIN}" - <<'PY'
import re
from pathlib import Path
p = Path('pyproject.toml')
text = p.read_text(encoding='utf-8')
m = re.search(r'^version\s*=\s*"([0-9]+)\.([0-9]+)\.([0-9]+)"', text, re.M)
if not m:
    raise SystemExit('未能从 pyproject.toml 读取版本')
print('.'.join(m.groups()))
PY
)

bump_version() {
  local version="$1"
  local level="$2"
  IFS='.' read -r major minor patch <<<"$version"

  case "$level" in
    patch)
      patch=$((patch + 1))
      ;;
    minor)
      minor=$((minor + 1))
      patch=0
      ;;
    major)
      major=$((major + 1))
      minor=0
      patch=0
      ;;
    *)
      echo "[release_py] 不支持的版本类型: $level (支持 patch/minor/major)" >&2
      exit 1
      ;;
  esac

  echo "${major}.${minor}.${patch}"
}

new_version=$(bump_version "$current_version" "$LEVEL")

"${PYTHON_BIN}" - "$new_version" <<'PY'
import re
from pathlib import Path
import sys

new_version = sys.argv[1]
p = Path('pyproject.toml')
old = p.read_text(encoding='utf-8')
pattern = re.compile(r'^(version\s*=\s*")([0-9]+\.[0-9]+\.[0-9]+)(")', re.M)
new = pattern.sub(lambda match: f'{match.group(1)}{new_version}{match.group(3)}', old, count=1)
if new == old:
    raise SystemExit('版本字段替换失败')
p.write_text(new, encoding='utf-8')
print('[release_py] 已写入新版本')
PY


echo "[release_py] 版本 ${current_version} -> ${new_version}"

rm -rf "$DIST_DIR"

run_python_module() {
  local module="$1"
  shift
  if [[ "$USE_UV" == 1 ]]; then
    local uv_args=("$UV_BIN" "run")
    if [[ -n "$UV_PYTHON" ]]; then
      uv_args+=("--python" "$UV_PYTHON")
    fi
    uv_args+=(--with build --with twine python -m "$module" "$@")
    "${uv_args[@]}"
  else
    "${PYTHON_BIN}" -m "$module" "$@"
  fi
}

echo "[release_py] 正在构建 Python 包..."
run_python_module build

echo "[release_py] 上传到 PyPI..."
run_python_module twine upload "$DIST_DIR"/*

echo "[release_py] 发布完成，当前版本: $new_version"
