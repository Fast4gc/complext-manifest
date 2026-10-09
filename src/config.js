import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raiz do projeto ancorada no arquivo, nao no cwd (painel pode abrir de outra pasta). */
const FILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Carrega .env (se existir) sem sobrescrever variáveis já presentes no ambiente.
 * Feito à mão para não depender de pacotes externos.
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const ENV_FILE = process.env.ENV_FILE || path.join(FILE_ROOT, '.env');
loadDotEnv(ENV_FILE);

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** true/false a partir de env; qualquer outro valor cai no padrao. */
function bool(value, fallback) {
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

/** Lista separada por virgulas, sem vazios, preservando a ordem. */
function list(value, fallback) {
  const items = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function dir(base, value, fallback) {
  return path.resolve(base, value || fallback);
}

const PROJECT_ROOT = FILE_ROOT;

export const config = {
  port: num(process.env.PORT, 3000),
  /**
   * Interface de escuta. Padrao local (127.0.0.1); o Docker Compose sobrescreve
   * para 0.0.0.0 dentro do container, publicando a porta so em 127.0.0.1 do host.
   */
  host: process.env.HOST || '127.0.0.1',

  /** Segredo das rotas /admin/*. Vazio => rotas admin desabilitadas (503). */
  adminToken: process.env.ADMIN_TOKEN || '',

  /** Onde chaves e cache são gravados (bind mount no Docker). */
  dataDir: dir(PROJECT_ROOT, process.env.DATA_DIR, 'data'),
  cacheDir: dir(
    PROJECT_ROOT,
    process.env.CACHE_DIR,
    path.join(process.env.DATA_DIR || 'data', 'cache'),
  ),

  /** Origem dos arquivos: repositório GitHub com uma branch por AppID. */
  github: {
    repository: (process.env.GITHUB_REPOSITORY || '').trim(),
    token: (process.env.GITHUB_TOKEN || '').trim(),
    apiUrl: (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    /**
     * Base para links brutos (raw) de arquivos de configuracao que o
     * servico NAO baixa: apontamos, o cliente busca. So muda em GitHub
     * Enterprise (substitua pelo host do raw da sua instancia).
     */
    rawUrl: (process.env.GITHUB_RAW_URL || 'https://raw.githubusercontent.com').replace(/\/+$/, ''),
    /** Nome da branch para um AppID. {appid} é substituído. */
    branchTemplate: process.env.BRANCH_TEMPLATE || '{appid}',
    timeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 15_000),
  },

  cache: {
    /** Idade máxima de uma entrada antes de checar o commit no GitHub. */
    ttlSeconds: num(process.env.CACHE_TTL_SECONDS, 300),
    /**
     * Se o GitHub estiver indisponível, aceita cache desta idade como stale.
     * Depois disso a API responde erro em vez de servir conteúdo velho.
     */
    staleMaxSeconds: num(process.env.CACHE_STALE_MAX_SECONDS, 7 * 24 * 3600),
    /**
     * Teto de disco do cache (bytes). Apos gravar uma entrada, entradas
     * menos usadas sao removidas ate caber. 0 = sem teto.
     */
    maxBytes: num(process.env.CACHE_MAX_BYTES, 5 * 1024 * 1024 * 1024),
  },

  /**
   * Fontes de manifests, em ordem de prioridade (a primeira que responder
   * com sucesso vence). `source=<id>` na consulta escolhe uma fonte
   * explicitamente — nesse caso NAO ha fallback para outra fonte.
   *
   * IDs conhecidos:
   *   manifesthub  steamtoolsapp/ManifestHub (publico, uma branch por AppID)
   *   github       GITHUB_REPOSITORY configurado pelo operador
   *
   * Fonte desabilitada ou sem configuracao e pulada (ou, se pedida por
   * `source=`, responde erro claro: fonte_desabilitada /
   * repositorio_nao_configurado). Nenhuma outra fonte esta integrada:
   * ver README > "Fontes suportadas" para o motivo de LuaTools e
   * Steam-Depot-Tools nao estarem.
   */
  sources: {
    priority: list(process.env.SOURCE_PRIORITY, ['github', 'manifesthub']),
    /** Projeto do ManifestHub; sobrescrevel para um fork proprio. */
    manifesthub: {
      repository: (process.env.MANIFESTHUB_REPOSITORY || 'steamtoolsapp/ManifestHub').trim(),
      branchTemplate: process.env.MANIFESTHUB_BRANCH_TEMPLATE || '{appid}',
      enabled: bool(process.env.MANIFESTHUB_ENABLED, true),
    },
    /** github ja vem de config.github (GITHUB_REPOSITORY). */
    github: {
      enabled: bool(process.env.GITHUB_SOURCE_ENABLED, true),
    },
  },

  /**
   * Pesquisa por nome de jogo -> AppID. Fonte publica verificada:
   * a loja da Steam (storesearch) nao exige token nem cadastro.
   */
  search: {
    enabled: bool(process.env.SEARCH_ENABLED, true),
    /** `term` e a query; resposta { total, items: [{ type, name, id }] }. */
    storeApiUrl: (process.env.STEAM_STORE_API_URL || 'https://store.steampowered.com/api').replace(/\/+$/, ''),
    timeoutMs: num(process.env.SEARCH_TIMEOUT_MS, 10_000),
    /** Resultados por resposta (a loja devolve no maximo ~10). */
    limit: Math.max(1, num(process.env.SEARCH_LIMIT, 10)),
    /**
     * Busca tem bucket proprio de rate limit, separado do da chave, para
     * uma rajada de buscas nao estourar a cota da loja. Tope por chave.
     */
    ratePerMinute: Math.max(1, num(process.env.SEARCH_RATE_PER_MINUTE, 20)),
    /** Cache em memoria de resultados por termo (evita martelar a loja). */
    ttlSeconds: num(process.env.SEARCH_TTL_SECONDS, 600),
  },

  /**
   * Links temporarios de download (?id= virando /d/<token>).
   *
   * Um link e um token assinado (HMAC) que embute appid, fonte e expiracao:
   * vencido ou adulterado, nao abre nada. So funciona se PUBLIC_BASE_URL
   * estiver definido (a API fica em 127.0.0.1; sem URL publica nao ha
   * como outro host alcancar /d/).
   */
  links: {
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    /** Validade padrao de um link, em segundos. */
    ttlSeconds: num(process.env.LINK_TTL_SECONDS, 900),
    ttlMaxSeconds: num(process.env.LINK_TTL_MAX_SECONDS, 86_400),
    /**
     * Segredo do HMAC. Se vazio, deriva de ADMIN_TOKEN (que o instalador
     * gera) — trocar ADMIN_TOKEN invalida todos os links emitidos.
     */
    secret: process.env.LINK_SECRET || process.env.ADMIN_TOKEN || '',
  },

  limits: {
    /** Tamanho máximo de um arquivo individual baixado. */
    maxFileBytes: num(process.env.MAX_FILE_BYTES, 50 * 1024 * 1024),
    /** Tamanho máximo do ZIP servido. */
    maxZipBytes: num(process.env.MAX_ZIP_BYTES, 200 * 1024 * 1024),
    /** Requisições por minuto por chave de API. */
    defaultRatePerMinute: num(process.env.DEFAULT_RATE_PER_MINUTE, 60),
  },

  /** Extensao do cache e ZIP de manifests; Lua usa download direto. */
  allowedExtension: '.manifest',

  discord: {
    token: (process.env.DISCORD_TOKEN || '').trim(),
    guildId: (process.env.DISCORD_GUILD_ID || '').trim(),
    /** Chave de API usada pelo bot para falar com a própria API. */
    apiKey: (process.env.DISCORD_API_KEY || '').trim(),
    apiUrl: (process.env.DISCORD_API_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    cooldownSeconds: num(process.env.DISCORD_COOLDOWN_SECONDS, 30),
    /** Limite de anexo do Discord (8 MB em servidores sem boost). */
    maxFileMb: num(process.env.DISCORD_MAX_FILE_MB, 8),
    timeoutMs: num(process.env.DISCORD_TIMEOUT_MS, 30_000),
  },
};

export const PROJECT_NAME = 'manifest-gate';
export { PROJECT_ROOT };
