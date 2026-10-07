# File Gate API

API de download com chaves de acesso. Valida formato do `id` e da chave, confere
se a chave está ativa/expirada/com uso disponível, e só então entrega os arquivos
permitidos como `.zip`.

## Rodando

```bash
npm install
cp .env.example .env   # edite ADMIN_TOKEN e FILES_DIR
ADMIN_TOKEN=seu-token node src/server.js
```

## Endpoints

### `GET /download?id=<appid>&key=<apikey>`

Fluxo de validação, nesta ordem:

1. `id` deve ser numérico (1–12 dígitos) → senão `400`
2. `key` deve ter o formato `mk_` + 32 chars alfanuméricos → senão `400`
3. Chave existe, não foi revogada, não expirou e tem usos restantes → senão `401`/`403`
4. Rate limit por chave (`rateLimitPerMinute`) → senão `429`
5. Arquivos em `FILES_DIR/<id>/` com extensão em `ALLOWED_EXTENSIONS` → senão `404`
6. Responde `200` com um `.zip` e consome 1 uso da chave

### Admin (exigem header `X-Admin-Token`)

| Rota | Descrição |
|---|---|
| `POST /admin/keys` | Cria chave. Body: `{ name?, expiresAt?, maxUses?, rateLimitPerMinute? }` |
| `GET /admin/keys` | Lista chaves (sem o valor da chave) |
| `DELETE /admin/keys/:id` | Revoga a chave |

A chave em texto só aparece na resposta do `POST`; depois disso fica apenas o
hash SHA-256 no `data/keys.json`.

### `GET /health`

## Organização dos arquivos

```
files/
└── 12345/          ← subpasta = id
    ├── a.lua       ← entregue
    ├── b.manifest  ← entregue
    └── notas.txt   ← ignorada (extensão fora da allowlist)
```

## Configuração (`.env`)

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `ADMIN_TOKEN` | — | Obrigatório para as rotas admin |
| `FILES_DIR` | `./files` | Raiz dos arquivos servidos |
| `ALLOWED_EXTENSIONS` | `.lua,.manifest` | Allowlist de extensões |
| `DATA_DIR` | `./data` | Onde `keys.json` é gravado |
