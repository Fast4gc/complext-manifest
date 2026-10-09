import { createApiClient, BOT_MESSAGES } from './apiClient.js';

export function apiDestination(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(URL invalida)';
  }
}

/** Only return known error codes; never dump HTTP errors or credentials. */
export async function checkBotApi({ baseUrl, key, timeoutMs = 5000, fetchImpl }) {
  const destination = apiDestination(baseUrl);
  try {
    await createApiClient({ baseUrl, key, timeoutMs, fetchImpl }).listSources();
    return { destination, ok: true };
  } catch (err) {
    return { destination, ok: false, code: Object.hasOwn(BOT_MESSAGES, err.code) ? err.code : 'api_indisponivel' };
  }
}
