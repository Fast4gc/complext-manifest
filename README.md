# Manifest Gate

API + bot do Discord que entregam o arquivo `.lua` existente em repositórios
GitHub com **uma branch por AppID**, autenticação por chave e busca por nome.

`GET /download?id=<appid>` e `/manifest appid:<AppID>` entregam o Lua original.
O arquivo `<appid>.lua` tem preferência; se não houver esse nome, só é aceito
um único Lua na branch. Sem Lua, a API retorna `sem_lua` (404); vários candidatos
sem correspondência retornam `lua_ambiguo` (409). A API não gera Lua a partir de
manifests nem executa scripts. O exemplo local não é enviado às fontes.

O ZIP antigo continua em `GET /download?id=<appid>&format=manifests`, com cache
persistente. Lua é baixado diretamente da fonte, com validação de integridade,
sem usar esse cache. JSON é apenas listado; VDF/KEY/ACF continuam excluídos.

## Fontes

| ID | Onde consulta | Credencial |
|---|---|---|
| `github` | `GITHUB_REPOSITORY` (seu repositório, branch por AppID) | `GITHUB_TOKEN` opcional |
| `manifesthub` | `steamtoolsapp/ManifestHub` (público, ~62 mil branches) | nenhuma (API pública do GitHub) |

- Ordem em `SOURCE_PRIORITY` (padrão `github,manifesthub`): a primeira que
  responder vence, as demais só entram em falha (fallback).
- `?source=<id>` escolhe **uma** fonte e **desliga** o fallback: o erro dela é
  o erro da resposta. ID desconhecido → `400 fonte_desconhecida`.
- A resposta traz `source`, `origin`, `version` (commit), `fetchedAt` e
  `attempts` (quais fontes falharam e com qual código).
- Erros de **autenticação** (`github_auth`) e **rate limit**
  (`github_rate_limit`) são propagados como tais — nunca viram "fonte
  indisponível" nem somem em silêncio.
- **Nunca listamos todas as branches** do ManifestHub: consultamos só a branch
  do AppID pedido.

**Por que só essas duas?** *LuaTools* exige login com conta Steam (OAuth) e
*Steam-Depot-Tools* está arquivado — sem documentação/utilização própria com
nossa credencial, não integramos. Está documentado em vez de fingir que
existe. Um terceiro provedor só entra se houver docs suficientes e
credencial própria nossa.

## Componentes

| Componente | Descrição |
|---|---|
| API (`src/server.js`) | Fontes, listagem, download, busca por nome, links temporários, health, status e docs |
| Provedores (`src/providers/`) | Contrato `availability/list/download/ping`, prioridade, fallback e registro de fontes |
| Bot (`src/bot/`) | Comandos `/manifest` e `/busca`, consomem a própria API e anexam o ZIP |
| Busca (`src/search.js`) | Nome → AppID pela busca pública da loja da Steam (fonte verificada, sem token) |
| Links (`src/links.js`) | Token HMAC com expiração, sem estado no servidor |
| Cache (`src/cache.js`) | Persistente em `./data/cache/<fonte>/<appid>`, compartilhado por API e bot |
| ZIP (`src/zip.js`) | Validação de entradas e da política antes de servir |
| CLI (`src/cli.js`) | Gera/revoga chaves sem subir a API (usado pelo instalador); sem argumentos abre o painel (`src/menu.js`) |
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
./install.sh restart    # sobe de novo com o .env atual (recria o que mudou)
./install.sh status     # docker compose ps + health check
./install.sh logs       # últimas 200 linhas  (./install.sh logs --follow)
./install.sh update     # git pull + rebuild + restart
./install.sh uninstall  # delega para uninstall.sh
```

> Depois de editar o `.env` manualmente, use `./install.sh restart`
> (equivalente a `docker compose --profile discord up -d`). Um simples
> `docker compose restart` **não** reaplica as variáveis novas.

---

## Configuração (`.env`)

Modelo completo e comentado: `.env.example`.

### Servidor e acesso

| Variável | Descrição |
|---|---|
| `PORT` / `HOST` | Porta e interface da API (padrão local: `127.0.0.1`) |
| `ADMIN_TOKEN` | Segredo das rotas `/admin/*` e (se `LINK_SECRET` vazio) dos links |
| `DEFAULT_RATE_PER_MINUTE` | Rate limit por minuto, por chave (padrão 60) |

> **Sobre `localhost:3000`:** os exemplos desta página e do `/docs` são locais.
> Com `HOST=127.0.0.1` a API **só escuta na própria máquina** — abrir
> `http://localhost:3000/health` de outro host ou de dentro de outro container
> não funciona. Para acesso externo preencha `PUBLIC_BASE_URL` (também é o que
> habilita os links temporários) e, se necessário, `HOST=0.0.0.0` atrás de um
> proxy reverso. A página `/docs` monta os exemplos com o host de quem abriu
> a página, não com `localhost` fixo.

### Fontes

| Variável | Descrição |
|---|---|
| `SOURCE_PRIORITY` | Ordem de fallback (padrão `github,manifesthub`) |
| `GITHUB_REPOSITORY` | **`owner/repo`** do seu repositório com branches por AppID. Vazio = fonte pulada |
| `GITHUB_TOKEN` | Opcional; sobe de ~60 para ~5000 req/h |
| `GITHUB_SOURCE_ENABLED` | `false` desliga só a fonte do operador |
| `GITHUB_API_URL` / `GITHUB_RAW_URL` | API do GitHub e base dos links brutos |
| `BRANCH_TEMPLATE` | Template da branch; `{appid}` é substituído (padrão `{appid}`) |
| `MANIFESTHUB_REPOSITORY` | Padrão `steamtoolsapp/ManifestHub` |
| `MANIFESTHUB_BRANCH_TEMPLATE` | Padrão `{appid}` |
| `MANIFESTHUB_ENABLED` | `false` desliga a fonte pública |

### Busca por nome

| Variável | Descrição |
|---|---|
| `SEARCH_ENABLED` | `false` desliga `/search` e `/busca` (padrão `true`) |
| `STEAM_STORE_API_URL` | Padrão `https://store.steampowered.com/api` |
| `SEARCH_TIMEOUT_MS` / `SEARCH_LIMIT` / `SEARCH_TTL_SECONDS` | Timeout, resultados por resposta e cache em memória |
| `SEARCH_RATE_PER_MINUTE` | Bucket próprio de rate limit, separado do da chave |

### Links temporários (opcional)

| Variável | Descrição |
|---|---|
| `PUBLIC_BASE_URL` | URL pública da API. **Sem ela o recurso fica desligado** (a API só escuta em `127.0.0.1`) |
| `LINK_SECRET` | Segredo da assinatura HMAC (cai para `ADMIN_TOKEN` se vazio) |
| `LINK_TTL_SECONDS` / `LINK_TTL_MAX_SECONDS` | Validade padrão (15 min) e teto (24 h); mínimo 60 s |

### Cache e limites

| Variável | Descrição |
|---|---|
| `DATA_DIR` / `CACHE_DIR` | Dados (padrão `./data`) e cache (vazio = `<DATA_DIR>/cache`) |
| `CACHE_TTL_SECONDS` | Idade até checar o commit da branch de novo (padrão 300) |
| `CACHE_STALE_MAX_SECONDS` | Idade máxima de cache servido com a fonte fora (padrão 7 dias) |
| `CACHE_MAX_BYTES` | Teto total do cache (padrão 5 GiB); estourou, sai o mais antigo |
| `REQUEST_TIMEOUT_MS` | Timeout das chamadas às fontes (15 s) |
| `MAX_FILE_BYTES` / `MAX_ZIP_BYTES` | Limites de tamanho (50 MB / 200 MB) |

### Discord

| Variável | Descrição |
|---|---|
| `DISCORD_TOKEN` | Token do bot (Discord Developer Portal) |
| `DISCORD_GUILD_ID` | ID do servidor, para registrar os comandos |
| `DISCORD_API_KEY` | Chave gerada pelo instalador (formato `mk_` + 32 chars) |
| `DISCORD_API_URL` | Padrão `http://api:3000` — **nome do serviço no Compose**, não `localhost` |
| `DISCORD_COOLDOWN_SECONDS` | Cooldown por usuário no Discord (30 s) |
| `DISCORD_MAX_FILE_MB` | Limite de anexo considerado (8 MB) |
| `DISCORD_TIMEOUT_MS` | Timeout das chamadas do bot à API (30 s) |

Formato aceito de repositório: `nome-do-repo/nome-do-repo` (sem URL).

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

> **Um aplicativo por bot.** O registro de comandos substitui a lista inteira
> da guild (`PUT` em `applicationGuildCommands`). Se você reaproveitar o token
> de outro bot, os comandos dele **somem** quando este subir — e, enquanto ele
> não subir, você continua vendo os comandos antigos respondendo
> "Comando desconhecido". Crie um aplicativo novo em
> <https://discord.com/developers/applications> para o manifest-gate, copie o
> token novo para `DISCORD_TOKEN` e reinicie. No boot o log lista exatamente
> o que foi publicado (`/manifest, /busca`) e avisa se a guild já tinha
> comandos de outro projeto.

Comportamento do `/manifest appid:<AppID>`:

- responde **imediatamente** confirmando que está processando (com o AppID e
  a fonte escolhida) e edita a mensagem com o `.lua` pronto;
- opção `fonte` com as escolhas vindo da API (`GET /sources`), mais fallback
  automático quando nada é escolhido;
- o resumo final traz a **proveniência**: fonte e commit;
- anexa o `.lua` original; se não houver Lua na fonte, informa o erro;
- cooldown por usuário (`DISCORD_COOLDOWN_SECONDS`);
- se o Lua exceder o limite de anexo, emite um **link temporário**
  (se `PUBLIC_BASE_URL` estiver configurado) com horário de expiração — e só
  se não houver link, aponta o endpoint da API;
- se a API estiver fora do ar ou a chave for inválida, responde mensagem
  amigável **sem expor credenciais**;
- erros da API (`branch_nao_encontrada`, `sem_manifests`,
  `github_rate_limit`, `fonte_desconhecida`…) viram textos em português.

`/busca nome:<texto>` — pesquisa o nome na loja da Steam e devolve os AppIDs
encontrados (cooldown próprio).

---

## Uso da API

Documentação interativa: `GET /docs`. Health: `GET /health`
(`?deep=1` também testa todas as fontes).

### Rotas

| Rota | Auth | O que faz |
|---|---|---|
| `GET /health` | — | Liveness (sem rede). Com `?deep=1`, testa cada fonte |
| `GET /status` | chave | Visão geral: fontes, cache, busca, links e limites |
| `GET /sources` | chave | Fontes, ordem efetiva, credencial declarada e limites |
| `GET /search?q=` | chave | Nome → AppID pela loja da Steam |
| `GET /manifests?id=` | chave | Lista os `.manifest` + proveniência + `configFiles` |
| `GET /download?id=` | chave | Arquivo `.lua` existente (padrão, ou `format=lua`) |
| `GET /download?id=&format=manifests` | chave | ZIP contendo **só** `.manifest` |
| `POST /links` | chave | Link temporário; `format` é `lua` por padrão ou `manifests` |
| `GET /links/:token` | — (token HMAC) | Consome o link temporário |
| `GET /docs` | — | Página de documentação |
| `/admin/keys` | `X-Admin-Token` | Gerir chaves |

### Autenticação

- Rotas de dados: chave no header `X-API-Key: <chave>` ou query `key=<chave>`.
- Rotas `/admin/*`: header `X-Admin-Token: <ADMIN_TOKEN>`.
- `GET /links/:token` não usa chave (a autorização está no token) e tem rate
  limit por IP.

### Exemplos

```bash
K="X-API-Key: SUA_CHAVE"

# O que existe (fontes, prioridade, limites)
curl -H "$K" "http://127.0.0.1:3000/sources"

# Buscar um jogo pelo nome (a loja devolve no maximo 10; cortamos aqui)
curl -H "$K" --get "http://127.0.0.1:3000/search" --data-urlencode "q=Counter-Strike 2"

# Listar manifests de um AppID (com proveniencia e fonte usada)
curl -H "$K" "http://127.0.0.1:3000/manifests?id=123456"

# Escolher a fonte explicitamente: sem fallback se ela falhar
curl -H "$K" "http://127.0.0.1:3000/manifests?id=123456&source=manifesthub"

# Forcar atualizacao de cache (checa o commit de novo)
curl -H "$K" "http://127.0.0.1:3000/manifests?id=123456&refresh=1"

# Baixar ZIP (cabecalhos X-Manifest-Gate-Source/Origin/Version/Fetched-At)
curl -OJ -H "$K" "http://127.0.0.1:3000/download?id=123456"

# Emitir um link temporario (15 min por padrao)
curl -X POST http://127.0.0.1:3000/links \
  -H "Content-Type: application/json" -H "$K" \
  -d '{"id":"123456","source":"manifesthub","ttl":600}'

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

### Painel interativo (menu)

Rode **sem argumentos** — abre uma tela com todas as ações do
backend: criar/listar/revogar chaves, buscar jogo por nome, baixar Lua,
consultar manifests de um AppID, baixar o ZIP, ver estatísticas
da cache, invalidar entrada por AppID, ver o status do serviço e
ainda iniciar a API ou o bot do Discord:

```bash
node src/cli.js        # ou: npm run key  ·  npm run menu
```

Atalho (evita o comando grande do Docker):

```bash
./menu-painel.sh                 # abre o painel (host com Node, ou container)
./menu-painel.sh key:list        # repassa args ao cli.js
./menu-painel.sh --install       # cria o comando global `menu-painel`
sudo menu-painel                 # abre de qualquer pasta (pede sudo sozinho no --install)
```

No Docker (host sem Node, como numa VPS), o mesmo painel
abre dentro do container — o `-it` é obrigatório para a
tela interativa (o `menu-painel.sh` já cuida disso):

```bash
docker compose run --rm -it --no-deps api node src/cli.js
```

Navegação: `↑` `↓` movem, `Enter` escolhe, `1-9` é atalho
direto, `Esc` volta, `Ctrl+C` sai. Em ambiente sem terminal
(pipe/Docker sem `-it`) o modo de comando acima é usado e o
painel não trava o script.

No menu `Serviço` há ainda **Atualizar via GitHub**: faz `git pull` +
rebuild das imagens + restart (equivale a `./install.sh update`),
preservando `.env` e `./data`. Dentro do container o painel avisa
para rodar o update no host, pois o container é efêmero.

### Fluxo de validação do `/download`

1. `id` numérico (1–12 dígitos) → senão `400 appid_invalido`
2. `source`, quando vier, precisa existir e estar habilitada → senão `400`
3. formato da chave (`mk_` + 32 alfanuméricos) → senão `400`
4. chave existente, ativa, não expirada, com usos (`401`/`403`)
5. rate limit por chave (`429`)
6. fonte escolhida por prioridade; se falhar, próxima (fallback). O resultado
   carrega `source`, `origin`, `version`, `fetchedAt` e `attempts`
Para `format=manifests`, o fluxo continua:

7. branch do AppID consultada; arquivos **classificados**: `manifest`
   baixado, `config` só listado, `forbidden` nem aparece
8. caminho, tamanho e integridade validados (SHA1 do blob git + SHA-256 do
   cache) antes de entrar no ZIP
9. política do ZIP conferida de novo (`assertZipPolicy`): só `.manifest`
10. ZIP servido (`X-Cache: hit|miss|stale` + headers de proveniência) e
    1 uso consumido

### Política de pacote — o que um pacote tem e de onde vem

Cada AppID é um pacote. O que existe e o que sai:

| Arquivo | Classe | Sai no ZIP? | Origem |
|---|---|---|---|
| `<appid>.manifest` e `<depot>_<manifest>.manifest` | `manifest` | **sim** | bruto da branch do AppID na fonte escolhida |
| `<appid>.lua` | `config` | **não** — entregue diretamente pelo download padrão | bruto da branch do AppID |
| `<appid>.json` | `config` | **não** — só listado | metadados e link da fonte |
| `key.vdf`, `*.vdf`, `*.key`, `*.acf`, `depotkeys.json` | `forbidden` | **não, e nem na listagem** | — |

O `rawUrl` aponta para `https://raw.githubusercontent.com/<repo>/refs/heads/<appid>/<arquivo>`,
ou seja, **para o repositório público de origem** — o mesmo que um navegador
abriria. O Lua também pode ser baixado pelo endpoint autenticado `/download`.
Um pacote não contém o que não existe na origem: o serviço não inventa
manifests, scripts nem chaves a partir de um AppID. Branches apenas com Lua
funcionam no download padrão, mesmo sem nenhum `.manifest`.

### Erros claros

`branch_nao_encontrada`, `sem_manifests`, `github_rate_limit`,
`github_timeout`, `github_indisponivel`, `github_auth`,
`fonte_desconhecida`, `fonte_desabilitada`, `repositorio_nao_configurado`,
`nenhuma_fonte`, `busca_invalida`, `busca_indisponivel`, `busca_timeout`,
`link_desabilitado`, `link_sem_segredo`, `link_ttl_invalido`,
`link_invalido`, `link_expirado`, `zip_grande_demais`,
`arquivo_grande_demais`, `falha_integridade`, `repositorio_invalido` —
cada um com mensagem em português e status HTTP adequado
(400/401/403/404/410/413/429/502/503/504). Quando há mais de uma tentativa
de fonte, o erro traz `attempts` com o código de cada uma.

---

## Cache

- Local: `./data/cache/<fonte>/<appid>/{meta.json,files/}` (volume `./data` no
  Docker). A entrada é **por fonte**: o mesmo AppID cacheado do ManifestHub não
  é confundido com o do seu repositório. Instalações antigas com o layout
  plano (`<cache>/<appid>/`) são migradas automaticamente na primeira
  execução.
- Consultas novas servem do cache dentro de `CACHE_TTL_SECONDS`.
- Após o TTL, a API consulta o SHA da branch; se o commit mudou, os arquivos
  são baixados de novo e os removidos são apagados.
- `refresh=1` força a checagem sob demanda.
- Fonte fora do ar: serve o cache velho (header `X-Cache: stale`) enquanto
  estiver dentro de `CACHE_STALE_MAX_SECONDS`; depois disso responde `502/504`.
- `CACHE_MAX_BYTES` limita o total: ao estourar, as entradas mais antigas são
  removidas primeiro; a que acabou de ser montada nunca é removida (senão o
  cache entraria em loop de baixar-e-apagar).
- **Sem downloads duplicados**: pedidos simultâneos do mesmo AppID compartilham
  a mesma ida (bloqueio por chave), e o mesmo arquivo não é baixado duas vezes
  no mesmo trabalho. Arquivo apagado ou corrompido é reparado na consulta
  seguinte.
- A proveniência fica na `meta.json`: fonte, repositório, branch, commit,
  data da consulta (`fetchedAt`/`checkedAt`), idade, bytes e contagem de
  manifests e de configs.
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
- `.env` criado com permissão `600`; nunca faça commit dele. O instalador
  **preserva** um `.env` já existente e só preenche o que falta.
- Credenciais digitadas no instalador são pedidas sem eco e nunca impressas.
- Logs registram apenas o caminho da rota (sem query string, portanto sem
  chaves); respostas e erros do bot não ecoam credenciais.
- **Nenhum token de terceiro vai embutido no código ou na imagem** — tudo
  entra pelo `.env` do operador.
- Caminhos validados contra traversal para `.manifest` e `.lua`.
- `key.vdf`, `*.vdf`, `*.key`, `*.acf` e `depotkeys.json` continuam excluídos.
  Lua é entregue como arquivo original; JSON é apenas listado.
- Arquivos recebidos são tratados como **dado**: validados e servidos como
  `application/octet-stream` (Lua) ou `application/zip`, nunca executados. Nenhum Lua é interpretado.
- Links temporários: payload assinado HMAC-SHA256 com AppID, fonte e
  expiração; adulteração → `link_invalido`, data vencida → `link_expirado`
  (410), TTL fora do intervalo recusado, token limitado a 2 KB.
- `/status`, `/sources` e `/search` não devolvem segredo algum (verificado
  por teste).

## Testes

```bash
npm test
```

Cobre (180 testes):

- **validação** — AppID, caminho, branch, chaves, IDs como string;
- **fontes e fallback** — ordem de prioridade, `source=` explícito sem
  fallback, código por fonte (`fonte_*`, `nenhuma_fonte`, `repositorio_...`),
  `attempts`, e a promoção de `github_auth`/`github_rate_limit`;
- **configuração quebrada** — um `GITHUB_REPOSITORY` no formato errado (ex.:
  um URL bruto colado no campo) é reportado como `valid: false` em
  `/health` e `/sources` **sem depender de rede**, e o `deep=1` mostra o
  código `repositorio_invalido` em vez de "fonte saudável"; o fallback ainda
  entrega o pacote pela outra fonte;
- **cache** — TTL, invalidação por commit, stale, reparo de integridade,
  migração do layout antigo, `CACHE_MAX_BYTES`, e concorrência provando
  **um** download para seis pedidos simultâneos;
- **busca** — normalização do termo, AppID como string, limite de
  resultados, cache em memória (com teto de 500), timeout e respostas
  malformadas;
- **links** — emissão, roundtrip, token adulterado, assinatura trocada,
  payload gigante, TTL fora do intervalo, expirado (410) e rate limit por IP;
- **ZIP** — só `.manifest`, sem `.lua`, sem chave, proveniência nos headers;
- **API** — autenticação, rate limit, erros, admin, `/sources`, `/status`,
  `/search`, headers `X-Manifest-Gate-*`;
- **bot** — cooldown, fluxo, proveniência, aviso de config, fonte repassada,
  progresso durante o processamento, ZIP grande → link temporário, vazamento
  de credencial;
- **instalador/desinstalador/bootstrap** — pastas temporárias com Docker
  simulado, `--purge`, recusa em pasta alheia, `restart` re-lendo o `.env` e
  migração de `DISCORD_API_URL`;
- **consultas reais** — API do GitHub (repositório neutro) e o **ManifestHub
  de verdade** pela branch do AppID, incluindo `rawUrl` de config apontando
  para arquivo existente. Sem rede, esses testes se ignoram (`skip`) em vez
  de falhar.

Os testes ignoram o `.env` local (`ENV_FILE` apontando para um arquivo
inexistente), para que segredos da sua máquina não mudem o resultado.

## Limites conhecidos

### Bot com `chave_nao_encontrada`

Para identificar o destino e testar a chave sem mostra-la, execute
`node src/cli.js bot:check` no ambiente do bot. No Compose, use
`docker compose --profile discord exec bot node src/cli.js bot:check`.
O resultado mostra a URL sem credenciais, a validacao na base local e a
resposta da API. Uma chave local valida nao garante que a API remota usa
a mesma base. Se o bot foi iniciado pelo painel, o diagnostico precisa
usar a mesma pasta/ambiente; um painel antigo pode reter variaveis antigas.

O token Discord e `DISCORD_API_KEY` sao credenciais diferentes. Se o bot
conecta mas a API recusa a chave, confira se `DISCORD_API_URL` aponta para
a API correta. No host dessa API, rode `./install.sh repair-discord-key`.
O comando gera uma nova chave no volume da API, atualiza `.env` sem exibir
o segredo e recria os servicos API/bot com o perfil Discord. As outras
chaves sao preservadas. Feche paineis antigos para descartar o ambiente
antigo; com o bot no Compose, nao inicie outra copia pelo painel.

`Unknown interaction` pode ocorrer quando a resposta inicial chega tarde.
O bot ja confirma os comandos antes das consultas de rede. Confira tambem
se ha outra instancia usando o mesmo token. Interacoes expiradas nao sao
respondidas novamente pelo tratamento de erro.

### Arquivos e fontes

- Somente extensão `.manifest` sai em ZIP (decisão de design; alterar exige
  mudar o código).
- Lua precisa existir na fonte configurada: o arquivo não é gerado a partir
  dos manifests. JSON permanece apenas listado.
- O bot precisa de `DISCORD_API_KEY` no formato `mk_` + 32 caracteres.
- Rate limit do GitHub sem token é baixo (~60 req/h); use `GITHUB_TOKEN`.
  Sem token, uma rajada de AppIDs distintos pode esgotar a cota — o erro é
  reportado como `github_rate_limit`, com o horário de reset.
- A busca por nome depende da loja da Steam (sem contrato de estabilidade);
  se a resposta mudar, o erro vira `busca_indisponivel` em vez de devolver
  dado inventado. O `limit` enviado à loja é **ignorado por ela** — o corte é
  feito aqui, no `SEARCH_LIMIT`.
- Links temporários exigem `PUBLIC_BASE_URL`: a API escuta apenas em
  `127.0.0.1`, então sem URL pública ninguém alcança `/links/<token>`.
