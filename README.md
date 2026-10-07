# Manifest Gate

API + bot do Discord que buscam arquivos `.manifest` em um repositório GitHub
com **uma branch por AppID**, com cache persistente, autenticação por chave e
entrega em ZIP.

> **Escopo permitido de arquivos:** apenas `.manifest` (fixo no código).
> Arquivos de chave (`.lua`, `depotkeys.json` etc.) **não são listados nem
> entregues**, e o repositório é definido por você em `GITHUB_REPOSITORY`
> (`owner/repo` do repositório que você tem permissão para distribuir).

## Componentes

| Componente | Descrição |
|---|---|
| API (`src/server.js`) | Lista e baixa manifests por AppID, valida chaves, health check e docs |
| Bot (`src/bot/`) | Comando `/manifest appid:` que consome a própria API e anexa o ZIP |
| Cache (`src/cache.js`) | Persistente em `./data/cache`, compartilhado por API e bot, invalidado por commit |
| CLI (`src/cli.js`) | Gera/revoga chaves sem subir a API (usado pelo instalador) |
| Docker | `Dockerfile` + `docker-compose.yml` (API sempre; bot via perfil `discord`) |

---

## Instalação (Ubuntu/Debian)

### Rápida, com curl ou wget

```bash
curl -fsSL https://raw.githubusercontent.com/Fast4gc/complext-manifest/main/bootstrap.sh | bash
# ou
wget -qO- https://raw.githubusercontent.com/Fast4gc/complext-manifest/main/bootstrap.sh | bash
```

> O código precisa estar publicado nesse repositório GitHub (faça push do
> projeto). O bootstrap baixa o código para `./manifest-gate` (ou para a pasta
> atual, se estiver vazia) e executa o `install.sh`. Os prompts continuam
> funcionando via `/dev/tty`, mesmo com stdin sendo um pipe.

Opções (com `bash -s --`):

```bash
curl -fsSL .../bootstrap.sh | bash -s -- --with-discord      # API + bot
curl -fsSL .../bootstrap.sh | bash -s -- --api-only          # só a API
curl -fsSL .../bootstrap.sh | bash -s -- --dir ~/manifest-gate
curl -fsSL .../bootstrap.sh | bash -s -- --update            # atualiza código e reinstala
curl -fsSL .../bootstrap.sh | bash -s -- --no-exec           # só baixa o código
curl -fsSL .../bootstrap.sh | bash -s -- --repo usuario/outro-repo --ref main
```

Segurança do bootstrap: só aceita URLs `https` (o `http` é aceito apenas para
`127.0.0.1`/`localhost`, em testes), recusa pastas que não são deste projeto e
nunca sobrescreve `.env` ou `./data`. Para revisar antes de rodar:

```bash
curl -fsSL .../bootstrap.sh -o bootstrap.sh && less bootstrap.sh && bash bootstrap.sh
```

Repositório privado? Clone manualmente e rode `./install.sh install` dentro da
pasta.

### Instalação a partir da pasta do projeto

```bash
./install.sh install                # pergunta: só API ou API + Discord
./install.sh install --api-only     # somente a API
./install.sh install --with-discord # API + bot do Discord
```

O instalador:

- roda **desta pasta** (não copia o projeto para outro lugar) — o mesmo vale
  após o bootstrap, que só baixa o código para a pasta de destino;
- reutiliza Docker/Compose já instalados; se faltarem, instala via `apt`
  (com `sudo`, se disponível);
- gera `ADMIN_TOKEN` automaticamente e, no modo Discord, gera a chave da API do
  bot via CLI — **as credenciais são pedidas sem eco e nunca exibidas**;
- **preserva `.env` e `./data` em reinstalações** (só preenche o que está vazio);
- cria `.env` com permissão `600`.

### Comandos do instalador

```bash
./install.sh start      # sobe os serviços
./install.sh stop       # para
./install.sh restart    # reinicia
./install.sh status     # docker compose ps + health check
./install.sh logs       # últimas 200 linhas  (./install.sh logs --follow)
./install.sh update     # git pull + rebuild + restart
./install.sh uninstall  # delega para uninstall.sh
```

---

## Configuração (`.env`)

| Variável | Descrição |
|---|---|
| `PORT` / `HOST` | Porta e interface da API (padrão local: `127.0.0.1`) |
| `ADMIN_TOKEN` | Segredo das rotas `/admin/*` (gerado no install) |
| `GITHUB_REPOSITORY` | **`owner/repo`** do repositório com branches por AppID |
| `GITHUB_TOKEN` | Opcional; aumenta o limite de requisições do GitHub |
| `GITHUB_API_URL` | Padrão `https://api.github.com` (mudar só para Enterprise/testes) |
| `BRANCH_TEMPLATE` | Nome da branch; `{appid}` é substituído (padrão `{appid}`) |
| `CACHE_TTL_SECONDS` | Idade até checar o commit da branch de novo (padrão 300) |
| `CACHE_STALE_MAX_SECONDS` | Idade máxima de cache servido com GitHub fora (padrão 7 dias) |
| `MAX_FILE_BYTES` / `MAX_ZIP_BYTES` | Limites de tamanho (50 MB / 200 MB) |
| `REQUEST_TIMEOUT_MS` | Timeout das chamadas ao GitHub (15 s) |
| `DISCORD_TOKEN` | Token do bot (Discord Developer Portal) |
| `DISCORD_GUILD_ID` | ID do servidor, para registrar `/manifest` |
| `DISCORD_API_KEY` | Chave gerada pelo instalador (formato `mk_` + 32 chars) |
| `DISCORD_API_URL` | Onde o bot chama a API (padrão `http://localhost:3000`) |
| `DISCORD_COOLDOWN_SECONDS` | Cooldown por usuário no Discord (30 s) |
| `DISCORD_MAX_FILE_MB` | Limite de anexo considerado (8 MB) |

Formato aceito de repositório: `nome-do-repos/nome-do-repo` (sem URL).

---

## Configuração do Discord

1. Crie um aplicativo em <https://discord.com/developers/applications> →
   **Bot** → copie o token.
2. Ative os *Message Content Intent* se necessário (o `/manifest` não precisa).
3. Pegue o ID do servidor: ative "Modo Desenvolvedor" → clique com botão
   direito no servidor → *Copiar ID*.
4. Preencha `DISCORD_TOKEN` e `DISCORD_GUILD_ID` no `.env` e rode
   `./install.sh install --with-discord` (ou `./install.sh restart`).
5. Convide o bot com `bot.commands` (scope `applications.commands`).

Comportamento do `/manifest appid:<AppID>`:

- responde imediatamente ("processando") e edita a mensagem com o ZIP pronto;
- cooldown por usuário (`DISCORD_COOLDOWN_SECONDS`);
- se o ZIP exceder o limite de anexo, avisa e indica o endpoint da API;
- se a API estiver fora do ar ou a chave for inválida, responde mensagem
  amigável **sem expor credenciais**;
- erros da API (`branch_nao_encontrada`, `sem_manifests`,
  `github_rate_limit`…) viram textos em português.

---

## Uso da API

Documentação interativa: `GET /docs`. Health: `GET /health`
(`?deep=1` também testa o GitHub).

### Autenticação

- Rotas `/manifests` e `/download`: chave no header `X-API-Key: <chave>` ou
  query `key=<chave>`.
- Rotas `/admin/*`: header `X-Admin-Token: <ADMIN_TOKEN>`.

### Exemplos

```bash
# Listar manifests de um AppID
curl -H "X-API-Key: SUA_CHAVE" "http://127.0.0.1:3000/manifests?id=123456"

# Baixar ZIP
curl -OJ -H "X-API-Key: SUA_CHAVE" "http://127.0.0.1:3000/download?id=123456"

# Forçar atualizacao de cache (checa commit no GitHub)
curl -H "X-API-Key: SUA_CHAVE" "http://127.0.0.1:3000/manifests?id=123456&refresh=1"

# Criar chave para um cliente
curl -X POST http://127.0.0.1:3000/admin/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: SEU_ADMIN_TOKEN" \
  -d '{"name":"cliente-1","maxUses":100,"expiresAt":"2026-12-31T00:00:00Z"}'

# Listar / revogar
curl -H "X-Admin-Token: SEU_ADMIN_TOKEN" http://127.0.0.1:3000/admin/keys
curl -X DELETE -H "X-Admin-Token: SEU_ADMIN_TOKEN" http://127.0.0.1:3000/admin/keys/<id>
```

### CLI de chaves (sem subir a API)

```bash
node src/cli.js key:create --name cliente-1 --uses 100
node src/cli.js key:list
node src/cli.js key:revoke <id>
node src/cli.js cache:stats
node src/cli.js cache:invalidate <appid>
# No Docker: docker compose run --rm --no-deps api node src/cli.js key:list
```

### Fluxo de validação do `/download`

1. `id` numérico (1–12 dígitos) → senão `400 appid_invalido`
2. formato da chave (`mk_` + 32 alfanuméricos) → senão `400`
3. chave existente, ativa, não expirada, com usos (`401`/`403`)
4. rate limit por chave (`429`)
5. branch do AppID consultada; `.manifest` filtrados com validação de caminho,
   tamanho e integridade (SHA1 do blob git + SHA-256 do cache)
6. ZIP servido (`X-Cache: hit|miss|stale`) e 1 uso consumido

### Erros claros

`branch_nao_encontrada`, `sem_manifests`, `github_rate_limit`,
`github_timeout`, `github_indisponivel`, `zip_grande_demais`,
`arquivo_grande_demais`, `falha_integridade`, `repositorio_nao_configurado`,
`repositorio_invalido` — cada um com mensagem em português e status HTTP
adequado (400/401/403/404/413/429/502/503/504).

---

## Cache

- Local: `./data/cache/<appid>/{meta.json,files/}` (volume `./data` no Docker).
- Consultas novas servem do cache dentro de `CACHE_TTL_SECONDS`.
- Após o TTL, a API consulta o SHA da branch; se o commit mudou, os arquivos
  são baixados de novo e os removidos são apagados.
- `refresh=1` força a checagem sob demanda.
- GitHub fora do ar: serve o cache velho (header `X-Cache: stale`) enquanto
  estiver dentro de `CACHE_STALE_MAX_SECONDS`; depois disso responde `502/504`.
- API e bot usam o mesmo diretório (compartilhado).

---

## Docker e VPS

```yaml
# Trechos do docker-compose.yml
ports: ["127.0.0.1:3000:3000"]   # API só local por padrão
restart: unless-stopped           # reinício automático
healthcheck: wget /health         # a API só é considerada saudável se responder
logging: json-file max-size 10m max-file 3   # rotação de logs
```

- Serviços: `api` (sempre) e `bot` (perfil `discord`).
- Logs: `./install.sh logs [--follow]` ou `docker inspect`/`docker logs`.

### Acesso externo (opcional)

Por padrão a API só responde em `127.0.0.1`. Para acessar de fora:

**Túnel SSH (sem expor porta):**
```bash
ssh -L 3000:127.0.0.1:3000 usuario@seu-vps
# agora http://127.0.0.1:3000 funciona na sua maquina
```

**Reverse proxy com HTTPS (Caddy):**
```caddyfile
api.seudominio.com {
    reverse_proxy 127.0.0.1:3000
}
```
Para liberar a porta no host, mude o mapeamento para `3000:3000` no Compose
**e** use proxy/reverso com TLS; mantenha `HOST=0.0.0.0` apenas dentro do
container. Não exponha a API sem TLS em rede pública.

---

## Atualização

```bash
./install.sh update        # git pull, rebuild das imagens e restart
```

Configurações (`./.env`) e cache (`./data`) são mantidos.

---

## Remoção

```bash
./uninstall.sh             # remove containers/rede deste projeto;
                            # preserva .env e ./data (cache + chaves)
./uninstall.sh --purge     # además apaga .env e ./data
```

- O desinstalador **nunca** remove Docker, dados ou serviços de outros projetos.
- O código-fonte é preservado; ao final ele imprime o comando para apagar a
  pasta quando você quiser: `rm -rf "<pasta-do-projeto>"`.

---

## Segurança

- Chaves armazenadas apenas como hash SHA-256; o valor só aparece no `POST`.
- `.env` criado com permissão `600`; nunca faça commit dele.
- Logs registram apenas o caminho da rota (sem query string, portanto sem
  chaves); respostas e erros do bot não ecoam credenciais.
- Caminhos de arquivo validados contra traversal; apenas `.manifest`.

---

## Testes

```bash
npm test
```

Cobre: validação (AppID, caminho, branch, chave), cache (TTL, invalidação por
commit, stale, reparo de integridade, limites), API (autenticação, ZIP, rate
limit, erros do GitHub, admin), bot (cooldown, fluxo, cliente HTTP, vazamento
de credencial), instalador/desinstalador e bootstrap `curl | bash` (em pastas
temporárias com Docker simulado e servidor local), incluindo recusa em pasta
alheia e `--purge`, e uma consulta real à API do GitHub.

## Limites conhecidos

- Somente extensão `.manifest` (decisão de design; alterar exige mudar o código).
- O bot precisa de `DISCORD_API_KEY` no formato `mk_` + 32 caracteres.
- Rate limit do GitHub sem token é baixo (~60 req/h); use `GITHUB_TOKEN`.
