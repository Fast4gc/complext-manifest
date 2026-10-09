#!/usr/bin/env bash
# ------------------------------------------------------------------
# Instalador do Manifest Gate (API + bot Discord)
#
# - Roda DENTRO desta pasta: nada e copiado para outros diretorios.
# - Ubuntu/Debian; reutiliza Docker/Compose existentes quando compativel.
# - Preserva .env e cache em reinstalacoes.
#
# Uso:
#   ./install.sh install [--api-only | --with-discord]
#   ./install.sh start|stop|restart|status
#   ./install.sh logs [--follow]
#   ./install.sh update
#   ./install.sh repair-discord-key
#   ./install.sh uninstall [--purge]
# ------------------------------------------------------------------
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
ENV_FILE="$PROJECT_DIR/.env"
PROJECT_NAME="manifest-gate"
PROFILE_ARGS=()
INSTALL_MODE="api"

log()  { printf '[instalador] %s\n' "$*"; }
warn() { printf '[instalador] AVISO: %s\n' "$*" >&2; }
die()  { printf '[instalador] ERRO: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

[ -f "$COMPOSE_FILE" ] || die "docker-compose.yml nao encontrado em $PROJECT_DIR"
grep -q "name: $PROJECT_NAME" "$COMPOSE_FILE" ||
  die "esta pasta nao parece ser um projeto $PROJECT_NAME (compose sem 'name: $PROJECT_NAME')"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
fi

# ------------------------------------------------------------------
# Docker / Compose
# ------------------------------------------------------------------
have_docker() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }

ensure_docker_daemon() {
  if docker info >/dev/null 2>&1; then return 0; fi
  if command -v systemctl >/dev/null 2>&1; then
    log "iniciando o daemon Docker..."
    $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  if docker info >/dev/null 2>&1; then return 0; fi
  die "daemon Docker nao respondeu. Rode:
    sudo systemctl start docker
  e confirme com: sudo systemctl status docker"
}

# Checa acesso ao daemon com mensagem acionavel (o erro cru do Compose
# e apenas "permission denied", sem dizer como resolver).
# Retorna 0 quando o problema nao e de permissoes (ex.: daemon parado).
ensure_docker_access() {
  local err
  err="$(docker info 2>&1 >/dev/null || true)"
  if [ -z "$err" ]; then return 0; fi
  case "$err" in
    *"permission denied"*) ;;
    *) return 0 ;;  # outro erro: trata em ensure_docker_daemon
  esac
  if [ "$(id -u)" -ne 0 ] &&
     getent group docker >/dev/null 2>&1 &&
     ! id -nG | tr ' ' '\n' | grep -qx docker; then
    die "$err
[instalador] ERRO: usuario '$USER' nao esta no grupo docker.
  Corrija com:
    sudo usermod -aG docker $USER
  Depois SAIA e entre de novo (ou rode: newgrp docker)
  e confirme com: docker info"
  fi
  die "$err
[instalador] ERRO: sem acesso ao socket do Docker. Rode o instalador
  com sudo ou peca ao administrador para colocar $USER no grupo docker."
}

# Compose (Bake) precisa do plugin buildx para buildar imagens.
ensure_builder() {
  if docker buildx version >/dev/null 2>&1; then return 0; fi
  warn "plugin buildx ausente (o Docker Compose precisa dele para buildar)."
  if command -v apt-get >/dev/null 2>&1 && [ -n "$SUDO" ] &&
     apt-cache show docker-buildx-plugin >/dev/null 2>&1; then
    log "instalando docker-buildx-plugin..."
    $SUDO apt-get install -y -qq docker-buildx-plugin >/dev/null 2>&1 || true
  fi
  if docker buildx version >/dev/null 2>&1; then return 0; fi
  die "buildx indisponivel. Instale com:
    sudo apt-get install -y docker-buildx-plugin
  ou baixe o binario de docker/buildx (GitHub) para:
    /usr/local/lib/docker/cli-plugins/docker-buildx"
}

install_docker() {
  command -v apt-get >/dev/null 2>&1 || die "so suportamos Ubuntu/Debian (apt-get ausente)"
  [ -n "$SUDO" ] || die "preciso de sudo/root para instalar pacotes"
  log "atualizando indice de pacotes..."
  $SUDO apt-get update -qq
  log "instalando dependencias (ca-certificates, curl)..."
  $SUDO apt-get install -y -qq ca-certificates curl gnupg >/dev/null

  if ! command -v docker >/dev/null 2>&1; then
    log "instalando Docker (docker.io)..."
    $SUDO apt-get install -y -qq docker.io >/dev/null ||
      die "falha ao instalar docker.io; instale o Docker manualmente e rode ./install.sh novamente"
  else
    log "Docker ja instalado, reutilizando."
  fi

  # Compose (Bake) precisa do buildx para buildar.
  if ! docker buildx version >/dev/null 2>&1; then
    $SUDO apt-get install -y -qq docker-buildx-plugin >/dev/null 2>&1 ||
      warn "docker-buildx-plugin nao disponivel via apt; o Compose avisara se precisar."
  fi

  if ! docker compose version >/dev/null 2>&1; then
    log "instalando plugin do Docker Compose..."
    installed=0
    for pkg in docker-compose-v2 docker-compose-plugin; do
      if apt-cache show "$pkg" >/dev/null 2>&1; then
        $SUDO apt-get install -y -qq "$pkg" >/dev/null 2>&1 && installed=1 && break
      fi
    done
    if [ "$installed" -eq 0 ] && ! docker compose version >/dev/null 2>&1; then
      log "baixando binario estatico do Docker Compose..."
      local arch
      arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
      case "$arch" in
        amd64|arm64) ;;
        *) arch="amd64" ;;
      esac
      local dest="/usr/local/lib/docker/cli-plugins/docker-compose"
      curl -fsSL \
        "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
        -o /tmp/docker-compose.pkg ||
        die "falha ao baixar o Docker Compose; instale manualmente e rode ./install.sh novamente"
      $SUDO install -D -m 0755 /tmp/docker-compose.pkg "$dest"
      rm -f /tmp/docker-compose.pkg
    fi
  fi

  docker compose version >/dev/null 2>&1 ||
    die "Docker Compose indisponivel apos a instalacao"
}

compose() {
  ensure_docker_access
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

# ------------------------------------------------------------------
# .env: geracao e preservacao
# ------------------------------------------------------------------
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

env_get() {
  [ -f "$ENV_FILE" ] || return 1
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

env_set() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 }; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

env_ensure() {  # env_ensure CHAVE VALOR_PADRAO  (so preenche se vazio)
  local current
  current="$(env_get "$1" || true)"
  if [ -z "$current" ]; then env_set "$1" "$2"; fi
}

# Com `curl | bash` o stdin e um pipe (sem terminal); usamos /dev/tty quando
# existir, para os prompts continuarem funcionando sem consumir o script.
can_use_tty() { [ -e /dev/tty ] && { : < /dev/tty; } 2>/dev/null; }

prompt_secret() {  # prompt_secret "texto"  -> imprime valor (sem eco) ou vazio
  local value=""
  if [ -t 0 ]; then
    read -r -s -p "$1" value
    printf '\n' >&2
  elif can_use_tty; then
    read -r -s -p "$1" value < /dev/tty
    printf '\n' >&2
  fi
  printf '%s' "$value"
}

prompt_line() {  # prompt_line "texto"
  local value=""
  if [ -t 0 ]; then
    read -r -p "$1" value
  elif can_use_tty; then
    read -r -p "$1" value < /dev/tty
  fi
  printf '%s' "$value"
}

setup_env() {
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$ENV_FILE.example" ]; then cp "$ENV_FILE.example" "$ENV_FILE";
    elif [ -f .env.example ]; then cp .env.example "$ENV_FILE";
    else die ".env.example ausente"; fi
    log ".env criado a partir do modelo."
  else
    log ".env existente preservado (reinstalacao)."
  fi

  # Credencial gerada automaticamente, nunca exibida.
  if [ -z "$(env_get ADMIN_TOKEN || true)" ]; then
    env_set ADMIN_TOKEN "$(random_hex)"
    log "ADMIN_TOKEN gerado automaticamente (guardado em .env)."
  fi

  if [ -z "$(env_get GITHUB_REPOSITORY || true)" ]; then
    local repo
    repo="$(prompt_line 'Repositorio GitHub com manifests (owner/repo, Enter para pular): ')"
    if [ -n "$repo" ]; then
      [[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] ||
        die "formato invalido de repositorio: use owner/repo"
      env_set GITHUB_REPOSITORY "$repo"
    else
      warn "GITHUB_REPOSITORY vazio: a API respondera 503 ate configurar no .env."
    fi
  fi

  if [ -z "$(env_get GITHUB_TOKEN || true)" ]; then
    local token
    token="$(prompt_secret 'Token GitHub (opcional, Enter para pular): ')"
    if [ -n "$token" ]; then env_set GITHUB_TOKEN "$token"; fi
  fi

  if [ "$INSTALL_MODE" = "discord" ]; then
    if [ -z "$(env_get DISCORD_TOKEN || true)" ]; then
      local dtok
      dtok="$(prompt_secret 'Token do bot Discord (obrigatorio): ')"
      [ -n "$dtok" ] || die "DISCORD_TOKEN e obrigatorio para instalar com Discord"
      env_set DISCORD_TOKEN "$dtok"
    fi
    if [ -z "$(env_get DISCORD_GUILD_ID || true)" ]; then
      local gid
      gid="$(prompt_line 'ID do servidor (guild) do Discord: ')"
      [[ "$gid" =~ ^[0-9]{5,25}$ ]] || die "ID de servidor invalido"
      env_set DISCORD_GUILD_ID "$gid"
    fi
  fi

  env_ensure PORT 3000
  env_ensure HOST 127.0.0.1
  # O bot roda DENTRO da rede do Compose: "localhost" dentro do container
  # seria ele proprio e a API nunca responderia. O nome de servico e "api".
  env_ensure DISCORD_API_URL "http://api:3000"
  local api_url
  api_url="$(env_get DISCORD_API_URL || true)"
  case "$api_url" in
    http://localhost:*|http://127.0.0.1:*|https://localhost:*|https://127.0.0.1:*)
      warn "DISCORD_API_URL aponta para localhost (inacessivel de dentro do container)."
      warn "ajustando para http://api:3000 (nome do servico no Compose)."
      env_set DISCORD_API_URL "http://api:3000"
      ;;
  esac
  env_set INSTALL_MODE "$INSTALL_MODE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

ensure_bot_key() {
  local current key_value
  current="$(env_get DISCORD_API_KEY || true)"
  if [ -n "$current" ] && [ "${1:-}" != "--replace" ]; then
    log "chave da API do bot ja existe no .env, preservada."
    return 0
  fi
  log "gerando chave da API para o bot..."
  key_value="$(
    compose run --rm --no-deps api node src/cli.js key:create --name discord-bot 2>/dev/null |
      sed -n 's/^KEY_VALUE=//p' | tail -n 1
  )"
  [ -n "$key_value" ] || die "falha ao gerar a chave da API (veja: docker compose logs)"
  env_set DISCORD_API_KEY "$key_value"
  log "chave da API do bot gerada (guardada em .env, sem exibicao)."
}

# ------------------------------------------------------------------
# Comandos
# ------------------------------------------------------------------
cmd_install() {
  if [ "${1:-}" = "--api-only" ]; then
    INSTALL_MODE="api"
  elif [ "${1:-}" = "--with-discord" ]; then
    INSTALL_MODE="discord"
  elif [ -t 0 ] || can_use_tty; then
    echo "O que voce quer instalar?"
    echo "  1) somente a API"
    echo "  2) API + bot do Discord"
    if [ -t 0 ]; then read -r -p '> ' choice; else read -r -p '> ' choice < /dev/tty; fi
    case "$choice" in
      2) INSTALL_MODE="discord" ;;
      *) INSTALL_MODE="api" ;;
    esac
  fi

  if ! have_docker; then
    install_docker
  else
    log "Docker e Compose ja instalados, reutilizando."
  fi

  # Ordem: acesso (socket) -> daemon -> builder (buildx).
  ensure_docker_access
  ensure_docker_daemon

  setup_env

  ensure_builder

  log "construindo imagens..."
  compose build

  log "subindo a API..."
  compose up -d api

  if [ "$INSTALL_MODE" = "discord" ]; then
    ensure_bot_key
    PROFILE_ARGS=(--profile discord)
    log "subindo o bot do Discord..."
    compose --profile discord up -d bot
  fi

  log "instalacao concluida."
  local port base
  port="$(env_get PORT || echo 3000)"
  base="$(env_get PUBLIC_BASE_URL || true)"
  if [ -n "$base" ]; then
    log "API: ${base}/  (docs em /docs, health em /health)"
  else
    log "API: http://127.0.0.1:${port}/  (docs em /docs, health em /health)"
    warn "esse endereco so abre NESTA maquina (HOST=127.0.0.1, PUBLIC_BASE_URL vazio). Para abrir de outro host, preencha PUBLIC_BASE_URL no .env e rode ./install.sh restart."
  fi
  if [ "$INSTALL_MODE" = "discord" ]; then
    log "Bot: registre o comando /manifest na sua guild (ja registrado automaticamente)."
  fi
}

current_profile_args() {
  local mode
  mode="$(env_get INSTALL_MODE || echo api)"
  if [ "$mode" = "discord" ]; then printf '%s' "--profile discord"; fi
}

cmd_start() {
  have_docker || die "Docker indisponivel"
  # shellcheck disable=SC2046
  compose $(current_profile_args) up -d
  log "servicos iniciados."
}

cmd_stop() {
  have_docker || die "Docker indisponivel"
  compose stop
  log "servicos parados."
}

cmd_restart() {
  have_docker || die "Docker indisponivel"
  # `restart` mantem os containers antigos com o ambiente VELHO do .env.
  # `up -d` recria so o que mudou e le o .env de novo — e quando nada mudou,
  # sai rapido igual.
  # shellcheck disable=SC2046
  compose $(current_profile_args) up -d
  log "servicos reiniciados (com o .env atual)."
}

cmd_status() {
  if ! have_docker; then
    warn "Docker indisponivel"
    exit 1
  fi
  compose ps
  local port url
  port="$(env_get PORT || echo 3000)"
  url="http://127.0.0.1:${port}/health"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS -m 5 "$url" >/dev/null 2>&1; then
      log "health check OK: $url (checagem local: a API so escuta em 127.0.0.1)"
    else
      warn "health check nao respondeu: $url"
      exit 1
    fi
  fi
}

cmd_logs() {
  have_docker || die "Docker indisponivel"
  if [ "${1:-}" = "--follow" ] || [ "${1:-}" = "-f" ]; then
    compose logs -f --tail=200
  else
    compose logs --tail=200
  fi
}

cmd_update() {
  have_docker || die "Docker indisponivel"
  if [ -d .git ]; then
    log "atualizando codigo (git pull)..."
    git pull --ff-only || warn "git pull falhou; continuando com o codigo atual."
  fi
  ensure_builder
  log "reconstruindo imagens..."
  compose build --pull
  # shellcheck disable=SC2046
  compose $(current_profile_args) up -d
  log "atualizacao concluida."
}

cmd_repair_discord_key() {
  have_docker || die "Docker indisponivel"
  [ -f "$ENV_FILE" ] || die ".env nao encontrado; rode install primeiro."
  ensure_bot_key --replace
  chmod 600 "$ENV_FILE"
  compose --profile discord up -d
  log "chave do bot reparada e containers atualizados. Feche e reabra paineis antigos para recarregar o ambiente."
}

cmd_uninstall() {
  exec "$PROJECT_DIR/uninstall.sh" "$@"
}

# ------------------------------------------------------------------
main() {
  local cmd="${1:-install}"
  [ $# -gt 0 ] && shift || true
  case "$cmd" in
    install)  cmd_install "$@" ;;
    start)    cmd_start "$@" ;;
    stop)     cmd_stop "$@" ;;
    restart)  cmd_restart "$@" ;;
    status)   cmd_status "$@" ;;
    logs)     cmd_logs "$@" ;;
    update)   cmd_update "$@" ;;
    repair-discord-key) cmd_repair_discord_key "$@" ;;
    uninstall) cmd_uninstall "$@" ;;
    -h|--help|help) usage ;;
    *) warn "comando desconhecido: $cmd"; usage 1 ;;
  esac
}

main "$@"
