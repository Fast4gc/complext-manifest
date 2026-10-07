#!/usr/bin/env bash
# ------------------------------------------------------------------
# Bootstrap do Manifest Gate: instalacao remota com curl ou wget.
#
# Uso (direto da internet):
#   curl -fsSL https://raw.githubusercontent.com/<usuario>/<repo>/main/bootstrap.sh | bash
#   wget -qO- https://raw.githubusercontent.com/<usuario>/<repo>/main/bootstrap.sh | bash
#
# Com opcoes:
#   curl -fsSL .../bootstrap.sh | bash -s -- --with-discord
#   curl -fsSL .../bootstrap.sh | bash -s -- --dir ~/manifest-gate --api-only
#   curl -fsSL .../bootstrap.sh | bash -s -- --update      # atualiza codigo existente
#
# Opcoes:
#   --repo <owner/repo>   repositorio do codigo (padrao: repositorio padrao do projeto)
#   --ref <branch|tag>    referencia git (padrao: main)
#   --dir <caminho>       pasta de destino (padrao: . se vazia; senao ./manifest-gate)
#   --url <tarball>       URL direta do tarball (espelhos/testes) — pula git/repo
#   --update              atualiza o codigo existente (git pull ou re-download)
#   --no-exec             apenas baixa o codigo, nao roda o install.sh
#   --api-only            repassado ao install.sh
#   --with-discord        repassado ao install.sh
#
# Seguranca:
#   - somente URLs https (http so para 127.0.0.1/localhost, em testes);
#   - nao apaga nada: recusa diretorio que nao e deste projeto;
#   - .env e ./data nunca sao sobrescritos.
#
# Para revisar o script antes de rodar:
#   curl -fsSL .../bootstrap.sh -o bootstrap.sh && less bootstrap.sh && bash bootstrap.sh
# ------------------------------------------------------------------
set -euo pipefail

DEFAULT_REPO="${INSTALL_REPO:-Fast4gc/complext-manifest}"
REPO="$DEFAULT_REPO"
REF="${INSTALL_REF:-main}"
DIR_ARG="${INSTALL_DIR:-}"
URL="${INSTALL_URL:-}"
DO_EXEC=1
DO_UPDATE=0
FORWARD=()

log()  { printf '[bootstrap] %s\n' "$*"; }
warn() { printf '[bootstrap] AVISO: %s\n' "$*" >&2; }
die()  { printf '[bootstrap] ERRO: %s\n' "$*" >&2; exit 1; }

usage() {
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -r "${BASH_SOURCE[0]}" ]; then
    sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  else
    echo "uso: curl -fsSL <url-do-bootstrap.sh> | bash -s -- [--repo o/r] [--ref main]"
    echo "          [--dir caminho] [--url tarball] [--update] [--no-exec]"
    echo "          [--api-only|--with-discord]"
  fi
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)  [ $# -ge 2 ] || die "--repo exige valor"; REPO="$2"; shift 2 ;;
    --ref)   [ $# -ge 2 ] || die "--ref exige valor"; REF="$2"; shift 2 ;;
    --dir)   [ $# -ge 2 ] || die "--dir exige valor"; DIR_ARG="$2"; shift 2 ;;
    --url)   [ $# -ge 2 ] || die "--url exige valor"; URL="$2"; shift 2 ;;
    --no-exec) DO_EXEC=0; shift ;;
    --update)  DO_UPDATE=1; shift ;;
    --api-only|--with-discord) FORWARD+=("$1"); shift ;;
    -h|--help|help) usage ;;
    *) warn "opcao desconhecida: $1"; usage 1 ;;
  esac
done

# ------------------------------------------------------------------
# Validacoes de origem
# ------------------------------------------------------------------
check_url_scheme() {
  case "$1" in
    https://*) ;;
    http://127.0.0.1*|http://localhost*) ;;
    *) die "URL rejeitada (somente https): $1" ;;
  esac
}

if [ -z "$URL" ]; then
  [[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "repositorio invalido: $REPO (use owner/repo)"
  # Nota: bash usa regex POSIX — nao usar \w (nao existe em POSIX ERE).
  [[ "$REF" =~ ^[A-Za-z0-9._/-]{1,240}$ ]] || die "referencia git invalida: $REF"
  case "$REF" in *..*) die "referencia git invalida: $REF" ;; esac
else
  check_url_scheme "$URL"
fi

fetch() {  # fetch URL -> stdout
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 180 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=180 "$1"
  else
    die "precisa de curl ou wget para baixar o codigo"
  fi
}

# ------------------------------------------------------------------
# Pasta de destino
# ------------------------------------------------------------------
resolve_target() {
  if [ -n "$DIR_ARG" ]; then
    printf '%s' "$DIR_ARG"
  elif [ -z "$(ls -A . 2>/dev/null)" ]; then
    printf '%s' "."          # pasta atual vazia: instala nela
  else
    printf '%s' "./manifest-gate"
  fi
}

TARGET="$(resolve_target)"
case "$TARGET" in
  ""|"/") die "destino invalido: '$TARGET'" ;;
esac

is_project_dir() {  # $1 = dir
  [ -f "$1/docker-compose.yml" ] && grep -q "name: manifest-gate" "$1/docker-compose.yml" 2>/dev/null
}

# ------------------------------------------------------------------
# Baixar o codigo
# ------------------------------------------------------------------
extract_to() {  # extract_to <tarball> <destino>
  local tarball="$1" dest="$2" tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/mg-extract.XXXXXX")"
  tar -xzf "$tarball" -C "$tmp"
  # Tarballs do GitHub tem um unico diretorio no topo.
  local top count
  count="$(find "$tmp" -mindepth 1 -maxdepth 1 | wc -l)"
  if [ "$count" -eq 1 ] && [ -d "$(find "$tmp" -mindepth 1 -maxdepth 1)" ]; then
    top="$(find "$tmp" -mindepth 1 -maxdepth 1)"
  else
    top="$tmp"
  fi
  mkdir -p "$dest"
  cp -a "$top/." "$dest/"
  rm -rf "$tmp"
}

download_tarball() {
  local url tarball
  if [ -n "$URL" ]; then
    url="$URL"
  else
    # INSTALL_CODELOAD_BASE existe para testes (aponta para um servidor local);
    # em producao o padrao e o codeload do GitHub.
    local base="${INSTALL_CODELOAD_BASE:-https://codeload.github.com}"
    base="${base%/}"
    url="${base}/${REPO}/tar.gz/${REF}"
  fi
  check_url_scheme "$url"
  log "baixando codigo ($url)..."
  tarball="$(mktemp "${TMPDIR:-/tmp}/mg-src.XXXXXX.tar.gz")"
  fetch "$url" > "$tarball" || { rm -f "$tarball"; die "falha ao baixar o codigo (verifique repo/ref/rede)"; }
  [ -s "$tarball" ] || { rm -f "$tarball"; die "download vazio"; }
  if ! tar -tzf "$tarball" >/dev/null 2>&1; then
    rm -f "$tarball"
    die "arquivo baixado nao e um tarball valido"
  fi
  extract_to "$tarball" "$TARGET"
  rm -f "$tarball"
}

git_clone_or_update() {
  # $1 = dir existente ou ""
  if [ -n "$1" ] && [ -d "$1/.git" ]; then
    log "atualizando codigo (git pull)..."
    git -C "$1" pull --ff-only || die "git pull falhou; resolva conflitos manualmente"
    return 0
  fi
  return 1
}

# ------------------------------------------------------------------
# Decisao sobre o destino
# ------------------------------------------------------------------
if [ -e "$TARGET" ]; then
  if is_project_dir "$TARGET"; then
    if [ "$DO_UPDATE" -eq 1 ]; then
      if ! git_clone_or_update "$TARGET"; then
        log "atualizando codigo (re-download)..."
        download_tarball   # sobrescreve apenas arquivos-fonte; .env/data intactos
      fi
    else
      log "projeto ja existe em $TARGET (configuracoes preservadas)."
    fi
  elif [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    die "'$TARGET' nao esta vazio e nao e um projeto Manifest Gate; nada foi alterado"
  else
    download_tarball
  fi
else
  download_tarball
fi

[ -f "$TARGET/install.sh" ] || die "download incompleto: install.sh ausente em $TARGET"
[ -f "$TARGET/docker-compose.yml" ] || die "download incompleto: docker-compose.yml ausente"
chmod +x "$TARGET/install.sh" "$TARGET/uninstall.sh" 2>/dev/null || true

if [ "$DO_EXEC" -eq 0 ]; then
  log "codigo pronto em: $TARGET (use: cd $TARGET && ./install.sh install)"
  exit 0
fi

log "executando o instalador em $TARGET..."
cd "$TARGET"
exec ./install.sh install "${FORWARD[@]+"${FORWARD[@]}"}"
