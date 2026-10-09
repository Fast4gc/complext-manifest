import { isValidAppId } from '../validate.js';
import { ApiError } from './apiClient.js';

/**
 * Fluxo do comando /manifest, sem depender do Discord (testavel isoladamente).
 *
 * Ordem: valida -> cooldown -> baixa Lua -> anexa (ou oferece link).
 * A confirmacao enquanto processa vem de `onProgress`: o chamador mostra a
 * mensagem antes de a API responder, e o resultado final substitui.
 *
 * @param {object} opts
 * @param {string} opts.appid     AppID informado pelo usuario
 * @param {object} opts.api       cliente de API (createApiClient)
 * @param {object} opts.cooldown  cooldown por usuario
 * @param {string} opts.userId    id do usuario (para cooldown)
 * @param {number} opts.maxBytes  limite de anexo do Discord
 * @param {string} [opts.source]  fonte escolhida (opcional)
 * @param {(text: string) => Promise<void>|void} [opts.onProgress]
 * @returns {Promise<{content: string, files?: Array<{attachment: Buffer, name: string}>}>}
 * @throws {ApiError} quando a API falha (mensagem ja amigavel)
 */
export async function runManifestCommand({
  appid,
  api,
  cooldown,
  userId,
  maxBytes,
  source,
  onProgress,
}) {
  if (!isValidAppId(appid)) {
    return { content: 'AppID invalido. Use apenas numeros, ex.: `/manifest appid:123456`.' };
  }

  const cd = cooldown.check(userId);
  if (!cd.ok) {
    return { content: `Aguarde **${cd.retryInSec}s** antes de pedir outro manifest.` };
  }

  // Conta como uso do cooldown mesmo se a API falhar (evita martelar a API).
  cooldown.hit(userId);

  await onProgress?.(
    `Baixando Lua do AppID **${appid}**` + (source ? ` na fonte \`${source}\`` : ' (prioridade do servidor)') + '…',
  );

  const { buffer, filename, ...provenance } = await api.download(appid, { source });
  const list = { ...provenance, count: 1, totalBytes: buffer.length };
  if (buffer.length > maxBytes) {
    return await tooBig({ api, appid, source: provenance.source || source, list, buffer, maxBytes });
  }
  const commit = String(provenance.commit || '').slice(0, 7);
  return {
    content: [
      `Arquivo Lua do AppID **${appid}**`,
      provenance.source ? `fonte \`${provenance.source}\`` : null,
      commit ? `commit \`${commit}\`` : null,
      `${(buffer.length / 1024).toFixed(1)} KB`,
    ].filter(Boolean).join(' · '),
    files: [{ attachment: buffer, name: filename }],
  };
}

/**
 * Lua acima do limite de anexo do Discord.
 * Primeiro tenta um link temporario (expira sozinho); se nao houver
 * PUBLIC_BASE_URL, avisa como usar a API direto.
 */
async function tooBig({ api, appid, source, list, buffer, maxBytes }) {
  const mb = (buffer.length / (1024 * 1024)).toFixed(1);
  const limitMb = (maxBytes / (1024 * 1024)).toFixed(0);
  const base =
    `O arquivo Lua do AppID **${appid}** tem **${list.count}** arquivo(s), ` +
    `**${((list.totalBytes || 0) / (1024 * 1024)).toFixed(1)} MB** e ficou com ${mb} MB, ` +
    `acima do limite de anexo do Discord (${limitMb} MB).`;

  // Se o cliente nao sabe emitir link (ou o servidor nao tem), cai direto
  // no aviso abaixo — sem vazar erro interno para o usuario.
  const fallback = {
    content:
      `${base}\nUse a API direto: \`GET /download?id=${appid}` +
      `${source ? `&source=${source}` : ''}\`.`,
  };
  if (typeof api.createLink !== 'function') return fallback;

  try {
    const link = await api.createLink(appid, { source });
    if (link?.url) {
      const when = link.expiresAt
        ? `Expira em **${new Date(link.expiresAt).toLocaleString('pt-BR')}**.`
        : 'Link temporário: expira sozinho.';
      return {
        content:
          `${base}\nBaixe por aqui (link temporário, sem chave de API):` +
          `\n<${link.url}>\n${when}`,
      };
    }
  } catch (err) {
    // link_desabilitado/link_sem_segredo/etc: cai no aviso abaixo, sem
    // que o usuario veja codigo interno.
    if (!(err instanceof ApiError)) throw err;
  }

  return fallback;
}

/** Converte ApiError em texto de resposta (fallback do index.js). */
export function errorReply(err) {
  if (err instanceof ApiError) return err.message;
  console.error('erro inesperado no bot:', err?.message || err);
  return 'Erro interno ao processar o comando, tente novamente.';
}
