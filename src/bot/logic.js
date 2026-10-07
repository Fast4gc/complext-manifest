import { isValidAppId } from '../validate.js';
import { ApiError } from './apiClient.js';

/**
 * Fluxo do comando /manifest, sem depender do Discord (testavel isoladamente).
 *
 * @param {object} opts
 * @param {string} opts.appid  AppID informado pelo usuario
 * @param {object} opts.api    cliente de API (createApiClient)
 * @param {object} opts.cooldown cooldown por usuario
 * @param {string} opts.userId id do usuario (para cooldown)
 * @param {number} opts.maxBytes limite de anexo do Discord
 * @returns {Promise<{content: string, files?: Array<{attachment: Buffer, name: string}>}>}
 * @throws {ApiError} quando a API falha (mensagem ja amigavel)
 */
export async function runManifestCommand({ appid, api, cooldown, userId, maxBytes }) {
  if (!isValidAppId(appid)) {
    return { content: 'AppID invalido. Use apenas numeros, ex.: `/manifest appid:123456`.' };
  }

  const cd = cooldown.check(userId);
  if (!cd.ok) {
    return { content: `Aguarde **${cd.retryInSec}s** antes de pedir outro manifest.` };
  }

  // Conta como uso do cooldown mesmo se a API falhar (evita martelar a API).
  cooldown.hit(userId);

  const list = await api.listManifests(appid);

  if (!list || list.count === 0) {
    return { content: `Nenhum .manifest encontrado para o AppID **${appid}**.` };
  }

  const { buffer, filename } = await api.download(appid);

  if (buffer.length > maxBytes) {
    const mb = (buffer.length / (1024 * 1024)).toFixed(1);
    const limitMb = (maxBytes / (1024 * 1024)).toFixed(0);
    return {
      content:
        `O pacote do AppID **${appid}** tem **${list.count}** arquivo(s), ` +
        `**${(list.totalBytes / (1024 * 1024)).toFixed(1)} MB** e ficou com ${mb} MB, ` +
        `acima do limite de anexo do Discord (${limitMb} MB). ` +
        `Use a API direto: \`GET /download?id=${appid}\`.',
    };
  }

  const staleNote = list.stale ? ' (cache antigo: GitHub indisponivel)' : '';
  return {
    content:
      `**${list.count}** manifest(s) do AppID **${appid}** — ` +
      `commit \`${String(list.commit).slice(0, 7)}\`${staleNote}`,
    files: [{ attachment: buffer, name: filename }],
  };
}

/** Converte ApiError em texto de resposta (fallback do index.js). */
export function errorReply(err) {
  if (err instanceof ApiError) return err.message;
  console.error('erro inesperado no bot:', err?.message || err);
  return 'Erro interno ao processar o comando, tente novamente.';
}
