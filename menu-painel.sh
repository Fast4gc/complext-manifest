#!/usr/bin/env bash
# ------------------------------------------------------------------
# menu-painel.sh — atalho para abrir o painel do Manifest Gate.
#
# Evita decorar o comando grande do Docker:
#   docker compose run --rm -it --no-deps api node src/cli.js
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

Evita decorar o comando grande do Docker:
  docker compose run --rm -it --no-deps api node src/cli.js

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

have_tty() { [ -t 0 ] && [ -t 1 ]; }

open_panel() {
  # 1) Host com Node + dependências: o mais simples, e é onde o
  #    `Serviço > Atualizar via GitHub` consegue rodar (git + docker).
  if command -v node >/dev/null 2>&1 && [ -f "$PROJECT_DIR/src/cli.js" ] && [ -d "$PROJECT_DIR/node_modules" ]; then
    exec node "$PROJECT_DIR/src/cli.js" "$@"
  fi
  # 2) Fallback: painel dentro do container (host sem Node).
  #    Nota: dentro do container o update precisa rodar no HOST —
  #    o painel avisa isso na hora.
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERRO: nem Node (com node_modules) nem Docker encontrados." >&2
    echo "No host: instale o Node 20+ e rode npm ci; ou use ./install.sh install." >&2
    exit 1
  fi
  local tty_args=()
  if have_tty; then tty_args=(-it); fi
  exec docker compose -p manifest-gate -f "$PROJECT_DIR/docker-compose.yml" \
    run --rm "${tty_args[@]+"${tty_args[@]}"}" --no-deps api node src/cli.js "$@"
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
