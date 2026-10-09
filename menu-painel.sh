#!/usr/bin/env bash
# ------------------------------------------------------------------
# menu-painel.sh — atalho para abrir o painel do Manifest Gate.
#
# Painel executado no host; prepara Node e dependencias locais se necessario.
#
# Uso:
#   ./menu-painel.sh                 # abre o painel interativo
#   ./menu-painel.sh key:list        # repassa args ao cli.js (modo de máquina)
#   ./menu-painel.sh --install       # instala atalho global `menu-painel`
#                                    # (pede sudo sozinho se preciso)
#   sudo menu-painel                 # abre o painel de qualquer pasta
# ------------------------------------------------------------------
set -euo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
cd "$PROJECT_DIR"

BIN_NAME="menu-painel"
GLOBAL_BIN="/usr/local/bin/$BIN_NAME"

usage() {
  cat <<'EOF'
menu-painel.sh — atalho para abrir o painel do Manifest Gate.

Painel no host: prepara Node e dependencias locais. API/bot usam Docker Compose.

Uso:
  ./menu-painel.sh                 # abre o painel interativo
  ./menu-painel.sh key:list        # repassa args ao cli.js (modo de máquina)
  ./menu-painel.sh --install       # instala atalho global `menu-painel`
                                   # (pede sudo sozinho se preciso)
  sudo menu-painel                 # abre o painel de qualquer pasta
EOF
  exit "${1:-0}"
}

cmd_install() {
  if [ ! -f "$PROJECT_DIR/src/cli.js" ]; then
    echo "ERRO: $PROJECT_DIR nao parece ser um projeto Manifest Gate (src/cli.js ausente)." >&2
    exit 1
  fi
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
      echo "[menu-painel] pedindo sudo para criar $GLOBAL_BIN ..."
      exec sudo "$SELF" --install
    else
      echo "ERRO: --install precisa de root (sem sudo disponivel)." >&2
      exit 1
    fi
  fi
  ln -sf "$SELF" "$GLOBAL_BIN"
  chmod +x "$GLOBAL_BIN"
  echo "[menu-painel] atalho instalado: $GLOBAL_BIN -> $SELF"
  echo "[menu-painel] uso: sudo menu-painel   (ou: menu-painel key:list)"
}

# O painel sempre roda no host. API e bot continuam nos servicos Compose.
prepare_runtime() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
     node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    return
  fi
  local runtime_dir="${XDG_DATA_HOME:-$HOME/.local/share}/manifest-gate/node22"
  if [ ! -x "$runtime_dir/bin/node" ]; then
    local arch tmp archive checksum
    case "$(uname -s):$(uname -m)" in
      Linux:x86_64) arch=x64 ;;
      Linux:aarch64|Linux:arm64) arch=arm64 ;;
      *) echo "Instale Node 22+ e npm no host para abrir o painel." >&2; exit 1 ;;
    esac
    for cmd in curl tar xz sha256sum; do
      command -v "$cmd" >/dev/null || { echo "Dependencia ausente no host: $cmd" >&2; exit 1; }
    done
    tmp="$(mktemp -d)"
    echo "[menu-painel] preparando Node 22 no host..."
    curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$tmp/SHASUMS256.txt"
    archive="$(awk -v arch="$arch" '$2 ~ ("^node-v22[.][0-9]+[.][0-9]+-linux-" arch "[.]tar[.]xz$") {print $2; exit}' "$tmp/SHASUMS256.txt")"
    [ -n "$archive" ] || { echo "Nao consegui identificar o pacote Node." >&2; exit 1; }
    checksum="$(awk -v name="$archive" '$2 == name {print $1}' "$tmp/SHASUMS256.txt")"
    curl -fsSL "https://nodejs.org/dist/latest-v22.x/$archive" -o "$tmp/$archive"
    (cd "$tmp"; printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -)
    mkdir -p "$(dirname "$runtime_dir")"
    tar -xJf "$tmp/$archive" -C "$tmp"
    mv "$tmp/${archive%.tar.xz}" "$runtime_dir"
    rm -rf "$tmp"
  fi
  export PATH="$runtime_dir/bin:$PATH"
}

open_panel() {
  if [ -f /.dockerenv ]; then
    echo "Abra ./menu-painel.sh no HOST da VPS, fora do container." >&2
    exit 1
  fi
  prepare_runtime
  local lock_hash installed_hash
  lock_hash="$(sha256sum package-lock.json | cut -d ' ' -f 1)"
  installed_hash="$(cat node_modules/.manifest-panel-lock 2>/dev/null || true)"
  if [ "$lock_hash" != "$installed_hash" ] || [ ! -d node_modules/discord.js ]; then
    echo "[menu-painel] preparando dependencias locais..."
    npm ci --omit=dev --no-audit --no-fund
    printf '%s\n' "$lock_hash" > node_modules/.manifest-panel-lock
  fi
  exec node "$PROJECT_DIR/src/cli.js" "$@"
}

case "${1:-}" in
  -h|--help|help) usage ;;
  --install) cmd_install ;;
  *)
    if [ ! -f "$PROJECT_DIR/src/cli.js" ]; then
      echo "ERRO: rode dentro da pasta do projeto ou instale com --install." >&2
      exit 1
    fi
    # Sem permissão de escrita o painel abre mas não salva chaves/cache:
    # avisa cedo em vez de falhar no meio.
    if [ -e "$PROJECT_DIR/.env" ] && [ ! -w "$PROJECT_DIR/.env" ]; then
      echo "[menu-painel] AVISO: .env sem escrita para este usuário; se falhar, rode com sudo." >&2
    fi
    open_panel "$@"
    ;;
esac
