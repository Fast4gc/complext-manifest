/**
 * Bot do Discord.
 *
 *   /manifest appid:<AppID> [fonte:<id>]   baixa o arquivo Lua existente
 *   /busca   nome:<texto>                  pesquisa nome -> AppID
 *
 * Consome a mesma API do backend (DISCORD_API_URL + DISCORD_API_KEY): o bot
 * nao fala com nenhuma fonte diretamente.
 *
 * Credenciais (DISCORD_TOKEN, DISCORD_API_KEY) nunca aparecem em logs ou
 * respostas. O token vem do .env, assim como o ID da guild.
 */
import { Client, GatewayIntentBits, REST, Routes, MessageFlags } from 'discord.js';
import { config } from '../config.js';
import { createApiClient, ApiError } from './apiClient.js';
import { createCooldown } from './cooldown.js';
import { runManifestCommand, errorReply } from './logic.js';

const { token, guildId, apiKey, apiUrl, cooldownSeconds, maxFileMb, timeoutMs } = config.discord;

function requireEnv(name, value) {
  if (!value) {
    console.error(`AVISO/ERRO: ${name} nao definido no ambiente.`);
    return false;
  }
  return true;
}

if (!requireEnv('DISCORD_TOKEN', token) || !requireEnv('DISCORD_GUILD_ID', guildId)) {
  console.error('Configure DISCORD_TOKEN e DISCORD_GUILD_ID no .env e reinicie o bot.');
  process.exit(1);
}
if (!requireEnv('DISCORD_API_KEY', apiKey)) {
  console.error('Configure DISCORD_API_KEY no .env (chave gerada pelo instalador).');
  process.exit(1);
}

const api = createApiClient({ baseUrl: apiUrl, key: apiKey, timeoutMs });
const cooldown = createCooldown(cooldownSeconds);
const searchCooldown = createCooldown(Math.max(5, Math.floor(cooldownSeconds / 2)));
const maxBytes = Math.floor(maxFileMb * 1024 * 1024);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/**
 * Opcao `fonte`. As escolhas vem da propria API (`/sources`) no boot: o
 * bot nunca inventa uma fonte que o servidor nao tem. Se a API estiver fora
 * no boot, o campo fica como texto livre e a API responde erro claro.
 */
const SOURCE_OPTION = {
  type: 3, // STRING
  name: 'fonte',
  description: 'Fonte dos manifests (deixe vazio para usar a prioridade do servidor)',
  required: false,
  choices: [],
};

const COMMANDS = [
  {
    name: 'manifest',
    description: 'Baixa o arquivo .lua disponivel para um AppID',
    options: [
      {
        type: 4, // INTEGER
        name: 'appid',
        description: 'AppID da Steam (ex.: 123456)',
        required: true,
        min_value: 1,
        max_value: 999999999999,
      },
      SOURCE_OPTION,
    ],
  },
  {
    name: 'busca',
    description: 'Pesquisa o AppID de um jogo pelo nome',
    options: [
      {
        type: 3, // STRING
        name: 'nome',
        description: 'Nome do jogo (ex.: counter-strike 2)',
        required: true,
        min_length: 2,
        max_length: 64,
      },
    ],
  },
];

function isMissingAccess(err) {
  const code = err?.code ?? err?.rawError?.code;
  const msg = String(err?.message || err || '');
  return code === 50001 || /missing access/i.test(msg);
}

function inviteUrl(appId) {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&permissions=34816&scope=bot+applications.commands`;
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);

  // Monta as escolhas de fonte a partir do que o servidor realmente tem.
  try {
    const sources = await api.listSources();
    const choices = (sources?.sources || [])
      .filter((s) => s.enabled && s.configured)
      .slice(0, 25)
      .map((s) => ({ name: `${s.id} — ${s.name}`.slice(0, 100), value: s.id }));
    if (choices.length > 0) {
      SOURCE_OPTION.choices = choices;
      console.log(`fontes no comando: ${choices.map((c) => c.value).join(', ')}`);
    } else {
      console.log('AVISO: nenhuma fonte configurada; campo fonte ficara livre.');
    }
  } catch (err) {
    if (err instanceof ApiError && ['chave_nao_encontrada', 'chave_revogada', 'chave_expirada', 'limite_de_usos_atingido'].includes(err.code)) {
      console.error('DISCORD_API_KEY recusada pela API. Confira DISCORD_API_URL e, no host da API, rode: ./install.sh repair-discord-key. Reabra paineis antigos apos o reparo.');
    }
    console.log(
      'AVISO: nao consegui listar /sources agora (' +
        (err?.code || 'erro') +
        '); campo fonte aceitara texto livre.',
    );
  }

  // O PUT abaixo faz *bulk overwrite*: substitui TODOS os comandos da guild
  // por esta lista. Se o mesmo aplicativo (token) estiver sendo usado por
  // outro bot, os comandos dele somem aqui — por isso avisa ANTES.
  try {
    const existing = await rest.get(
      Routes.applicationGuildCommands(client.application.id, guildId),
    );
    const known = new Set(COMMANDS.map((c) => c.name));
    const foreign = (Array.isArray(existing) ? existing : [])
      .map((c) => c?.name)
      .filter((n) => n && !known.has(n));
    if (foreign.length > 0) {
      console.warn(
        `AVISO: a guild ${guildId} tem comandos de OUTRO projeto neste mesmo aplicativo ` +
          `(${foreign.map((n) => `/${n}`).join(', ')}). O registro do manifest-gate vai remove-los; ` +
          'se eles forem de outro bot, use um token/aplicativo proprio no DISCORD_TOKEN.',
      );
    }
  } catch (err) {
    // Sem permissao ou lista vazia: nao impede o registro.
    // Missing Access aqui quase sempre = bot sem scope applications.commands.
    if (isMissingAccess(err)) {
      console.log(
        `aviso: sem acesso para ler os comandos da guild ${guildId} (Missing Access). ` +
          `O bot provavelmente foi convidado sem o scope applications.commands. ` +
          `Reconvide com: ${inviteUrl(client.application.id)}`,
      );
    } else {
      console.log('aviso: nao consegui ler os comandos atuais da guild:', err?.message || err);
    }
  }

  try {
    await rest.put(Routes.applicationGuildCommands(client.application.id, guildId), {
      body: COMMANDS,
    });
    console.log(
      `comandos registrados na guild ${guildId}: ${COMMANDS.map((c) => `/${c.name}`).join(', ')}`,
    );
  } catch (err) {
    if (isMissingAccess(err)) {
      throw new Error(
        `Missing Access na guild ${guildId}: o bot esta no servidor mas sem o scope applications.commands. ` +
          `Reconvide o bot com: ${inviteUrl(client.application.id)} ` +
          `e reinicie. (Detalhe original: ${err?.message || err})`,
      );
    }
    throw err;
  }
}

client.once('clientReady', async () => {
  console.log(`bot online como ${client.user?.tag || '(sem tag)'}; guild=${guildId}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('falha ao registrar comandos:', err?.message || err);
  }
});

/** Resposta visivel enquanto a API trabalha (antes de terminar). */
async function progress(interaction, text) {
  try {
    if (interaction.deferred) await interaction.editReply({ content: `⏳ ${text}` });
  } catch (err) {
    console.warn('nao consegui atualizar o status:', err?.message || err);
  }
}

async function finish(interaction, result) {
  const payload = { content: result.content };
  if (result.files && result.files.length > 0) payload.files = result.files;
  await interaction.editReply(payload);
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;
  try {
    if (interaction.commandName === 'manifest') {
      const appid = String(interaction.options.getInteger('appid'));
      const source = interaction.options.getString('fonte') || undefined;

      // Confirma imediatamente (defer) e diz o que vai fazer.
      await interaction.deferReply();
      await progress(
        interaction,
        `Buscando Lua do AppID **${appid}**` +
          (source ? ` na fonte \`${source}\`` : '') +
          '…',
      );

      const result = await runManifestCommand({
        appid,
        api,
        cooldown,
        userId,
        maxBytes,
        source,
        onProgress: (text) => progress(interaction, text),
      });
      await finish(interaction, result);
      return;
    }

    if (interaction.commandName === 'busca') {
      const query = String(interaction.options.getString('nome') || '');
      const cd = searchCooldown.check(userId);
      if (!cd.ok) {
        await interaction.reply({
          content: `Aguarde **${cd.retryInSec}s** antes de pesquisar de novo.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      searchCooldown.hit(userId);

      await interaction.deferReply();
      const found = await api.search(query);

      if (!found?.results?.length) {
        await interaction.editReply({
          content: `Nenhum jogo encontrado para **${query}**.`,
        });
        return;
      }

      const lines = found.results.map(
        (r) => `• **${r.name || '(sem nome)'}** — AppID \`${r.appid}\` (${r.type})`,
      );
      await interaction.editReply({
        content:
          `Resultados para **${found.query}**:\n${lines.join('\n')}\n` +
          `\nUse \`/manifest appid:<AppID>\` para baixar o .lua.`,
      });
      return;
    }

    await interaction.reply({ content: 'Comando desconhecido.', flags: MessageFlags.Ephemeral });
  } catch (err) {
    // Discord ja invalidou o token ou outra instancia confirmou a interacao.
    // Repetir reply aqui apenas produz outro erro e pode disputar com outro bot.
    if ([10062, 40060].includes(Number(err?.code ?? err?.rawError?.code))) {
      console.warn('Interacao expirada ou ja confirmada. Confira a latencia e se ha outra instancia deste bot em execucao.');
      return;
    }
    const text =
      err instanceof ApiError && err.code === 'limite_de_requisicoes'
        ? err.message
        : errorReply(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: text });
      } else {
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      }
    } catch (replyErr) {
      console.error('falha ao responder interacao:', replyErr?.message || replyErr);
    }
  }
});

client.on('error', (err) => console.error('erro do cliente Discord:', err?.message || err));

client.login(token).catch((err) => {
  // Nao imprime o token: apenas a mensagem de erro do Discord.
  console.error('falha ao conectar ao Discord:', err?.message || err);
  process.exit(1);
});
