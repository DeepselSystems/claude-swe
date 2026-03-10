import { App, LogLevel } from '@slack/bolt';
import { config } from '../config.js';
import { logger } from '../logger.js';

let slackApp: App | null = null;

export function getSlackApp(): App | null {
  return slackApp;
}

export function isSlackConfigured(): boolean {
  return !!(config.slack.botToken && config.slack.appToken);
}

/** Initialize and start the Bolt app in Socket Mode. No-op if Slack is not configured. */
export async function startSlack(): Promise<void> {
  if (!isSlackConfigured()) {
    logger.info('Slack not configured (missing botToken or appToken) — skipping Slack startup');
    return;
  }

  slackApp = new App({
    token: config.slack.botToken!,
    appToken: config.slack.appToken!,
    signingSecret: config.slack.signingSecret ?? undefined,
    socketMode: true,
    logger: {
      debug: (msg) => logger.debug({ component: 'slack-bolt' }, msg),
      info: (msg) => logger.info({ component: 'slack-bolt' }, msg),
      warn: (msg) => logger.warn({ component: 'slack-bolt' }, msg),
      error: (msg) => logger.error({ component: 'slack-bolt' }, msg),
      setLevel: () => {},
      getLevel: () => LogLevel.INFO,
      setName: () => {},
    },
  });

  // Register event handlers (imported here to avoid circular deps at module init time)
  const { registerSlackHandlers } = await import('./handler.js');
  registerSlackHandlers(slackApp);

  await slackApp.start();
  logger.info('Slack Socket Mode connection established');
}

/** Post a message in a Slack thread. Safe to call even if Slack is not configured. */
export async function postSlackReply(channelId: string, threadTs: string, text: string): Promise<void> {
  if (!slackApp) {
    logger.warn({ channelId, threadTs }, 'Attempted to post Slack reply but Slack is not started');
    return;
  }
  await slackApp.client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
  });
}
