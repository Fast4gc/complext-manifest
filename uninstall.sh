#!/usr/bin/env bash
# ------------------------------------------------------------------
# Desinstalador do Manifest Gate
#
# - Remove apenas os servicos/containers/REDE deste projeto
#   (projeto Compose "manifest-gate").
# - POR PADRAO preserva configuracoes (.env) e cache/dados (./data).
#   Use --purge para apagar tambem .env e ./data.
# - NUNCA remove Docker, dados ou servicos de outros projetos.
# - NAO apaga o codigo-fonte; ao final imprime como remover a pasta.
#
# Uso:
#   ./uninstall.sh          # remove servicos, preserva .env e cache
#   ./uninstall.sh --purge  # remove servicos + .env + ./data (cache e chaves)
# ------------------------------------------------------------------
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
ENV_FILE="$PROJECT_DIR/.env"
PROJECT_NAME="manifest-gate"
PURGE=0

log()  { printf '[desinstalador] %s\n' "$*"; }
warn() { printf '[desinstalador] AVISO: %s\n' "$*" >&2; }
die()  { printf '[desinstalador] ERRO: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "argumento desconhecido: $arg (uso: --purge)" ;;
  esac
done

# ------------------------------------------------------------------
# Seguranca: so age em uma pasta que realmente e deste projeto
# ------------------------------------------------------------------
[ -n "$PROJECT_DIR" ] || die "diretorio do projeto vazio"
[ "$PROJECT_DIR" != "/" ] || die "recusando rodar na raiz do sistema"
[ -f "$COMPOSE_FILE" ] || die "docker-compose.yml nao encontrado em $PROJECT_DIR"
grep -q "name: $PROJECT_NAME" "$COMPOSE_FILE" ||
  die "esta pasta nao e de um projeto $PROJECT_NAME; nada foi removido"
[ -f "$PROJECT_DIR/package.json" ] ||
  die "package.json nao encontrado; nada foi removido"

# ------------------------------------------------------------------
# Para/remove apenas os servicos deste projeto
# ------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "parando servicos do projeto '$PROJECT_NAME'..."
  # --profile discord garante que o bot (se exista) tambem seja removido.
  if ! docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" --profile discord down --remove-orphans; then
    warn "o Compose reportou problemas; verifique com: docker compose -p $PROJECT_NAME ps"
  fi
else
  warn "Docker/Compose indisponivel: remocao de containers pulada."
  warn "Se existirem, remova manualmente com: docker compose -p $PROJECT_NAME down"
fi

# ------------------------------------------------------------------
# Dados
# ------------------------------------------------------------------
if [ "$PURGE" -eq 1 ]; then
  log "purge: removendo cache/chaves (./data) e configuracoes (.env)..."
  if [ -d "$PROJECT_DIR/data" ]; then
    case "$PROJECT_DIR/data" in
      "$PROJECT_DIR/data") rm -rf -- "$PROJECT_DIR/data" ;;
      *) die "caminho de dados suspeito, abortando" ;;
    esac
  fi
  if [ -f "$ENV_FILE" ]; then rm -f -- "$ENV_FILE"; fi
  log "purge concluido. Codigo-fonte preservado."
else
  log "configuracoes (.env) e cache/dados (./data) preservados."
  log "para apaga-los: ./uninstall.sh --purge"
fi

# ------------------------------------------------------------------
# Codigo-fonte: preservado de proposito
# ------------------------------------------------------------------
log "codigo-fonte preservado em: $PROJECT_DIR"
log "para remover a pasta manualmente, rode quando quiser:"
printf '         rm -rf "%s"\n' "$PROJECT_DIR"
log "remocao concluida. Docker e outros projetos nao foram afetados."
