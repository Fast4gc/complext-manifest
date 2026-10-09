/** Services are managed by Compose; the panel never launches a second bot. */
export function serviceArgs(action) {
  const commands = {
    api: ['up', '-d', 'api'],
    bot: ['--profile', 'discord', 'up', '-d', 'api', 'bot'],
    stopbot: ['--profile', 'discord', 'stop', 'bot'],
    logs: ['--profile', 'discord', 'logs', '-f', '--tail=50', 'api', 'bot'],
    containers: ['--profile', 'discord', 'ps'],
  };
  if (!Object.hasOwn(commands, action)) throw new Error('Acao de servico invalida');
  return ['compose', ...commands[action]];
}
