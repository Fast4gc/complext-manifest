/**
 * Bot do Discord: comando /manifest appid:<AppID>.
 * Consome a mesma API do backend (DISCORD_API_URL + DISCORD_API_KEY).
 *
 * Credenciais (DISCORD_TOKEN, DISCORD_API_KEY) nunca aparecem em logs ou respostas.
 */
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
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
const maxBytes = Math.floor(maxFileMb * 1024 * 1024);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const COMMAND = {
  name: 'manifest',
  description: 'Lista e baixa os manifests disponiveis para um AppID',
  options: [
    {
      type: 4, // INTEGER
      name: 'appid',
      description: 'AppID da Steam (ex.: 123456)',
      required: true,
      min_value: 1,
      max_value: 999999999999,
    },
  ],
};

client.once('clientReady', async () => {
  console.log(`bot online como ${client.user?.tag || '(sem tag)'}; guild=${guildId}`);
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationGuildCommands(client.application.id, guildId), {
      body: [COMMAND],
    });
    console.log('comando /manifest registrado na guild');
  } catch (err) {
    console.error('falha ao registrar comandos:', err?.message || err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'manifest') return;

  const userId = interaction.user.id;
  try {
    // Resposta imediata enquanto processa (defer).
    await interaction.deferReply();

    const result = await runManifestCommand({
      appid: String(interaction.options.getInteger('appid')),
      api,
      cooldown,
      userId,
      maxBytes,
    });

    if (result.files && result.files.length > 0) {
      await interaction.editReply({ content: result.content, files: result.files });
    } else {
      await interaction.editReply({ content: result.content });
    }
  } catch (err) {
    const text =
      err instanceof ApiError && err.code === 'limite_de_requisicoes'
        ? err.message
        : errorReply(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: text });
      } else {
        await interaction.reply({ content: text, ephemeral: true });
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
