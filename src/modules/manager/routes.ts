import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { EvolutionWebhookPayload } from '../../types/evolution.js';
import { env } from '../../config/env.js';
import { evolution } from '../../lib/evolution.js';
import { generateSqlFromQuestion } from './sql-generator.js';
import { executeAndFormatQuery } from './executor.js';

/**
 * Checks whether the sender is authorized to query managerial business intelligence.
 */
export function isAuthorizedManager(senderPhone: string): boolean {
  const ownerPhone = env.STORE_OWNER_PHONE ? env.STORE_OWNER_PHONE.replace(/[^0-9]/g, '') : '';
  if (!ownerPhone) {
    return true;
  }
  const cleanSender = senderPhone.replace(/[^0-9]/g, '');
  const ownerLast10 = ownerPhone.slice(-10);
  const senderLast10 = cleanSender.slice(-10);
  return cleanSender === ownerPhone || (ownerLast10.length === 10 && senderLast10 === ownerLast10);
}

/**
 * Executes a manager query (Text-to-SQL -> safe query -> formatted report)
 * and dispatches the response via Evolution API.
 */
export async function executeManagerQuery(params: {
  question: string;
  senderPhone: string;
  instance: string;
  log?: FastifyInstance['log'];
}): Promise<void> {
  const { question, senderPhone, instance, log } = params;

  try {
    log?.info({ senderPhone, question }, '🔍 Processing manager analytics query...');

    // 1. Generate sanitized read-only SQL via Gemini
    const { sql, explanation } = await generateSqlFromQuestion(question);
    log?.info({ sql, explanation }, '⚡ Generated safe SQL query');

    // 2. Execute query & format natural response
    const report = await executeAndFormatQuery({
      question,
      sql,
      explanation,
    });

    // 3. Send formatted summary back via Evolution API
    await evolution.sendTextMessage(instance, senderPhone, report);
    log?.info({ senderPhone }, '✅ Analytics report successfully dispatched');
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log?.error({ error: errMsg }, '❌ Failed to process manager analytics query');

    if (senderPhone) {
      const errorReply = `⚠️ *Analytics Assistant Notice*\n\nUnable to answer: ${errMsg}\n\n_Tip: Try asking questions like "Today's sales", "Who owes udhaar?", or "ఈరోజు అమ్మకాలు ఎంత?"._`;
      try {
        await evolution.sendTextMessage(instance, senderPhone, errorReply);
      } catch (sendErr: unknown) {
        log?.warn({ sendErr }, 'Failed to send error notification back to manager');
      }
    }
  }
}

/**
 * Handles incoming WhatsApp messages from the Manager Bot instance
 * for Text-to-SQL business intelligence queries.
 */
async function processInboundManagerMessage(
  payload: EvolutionWebhookPayload,
  log: FastifyInstance['log']
): Promise<void> {
  const { instance, data } = payload;
  const messageId = data?.key?.id || `msg-${Date.now()}`;
  const sender = data?.key?.remoteJid;
  const messageContent = data?.message;

  if (!messageContent) {
    return;
  }

  const senderPhone = sender ? sender.replace(/[^0-9]/g, '') : '';

  // 1. Authorization: Only allow registered store owner to query manager bot
  if (!isAuthorizedManager(senderPhone)) {
    log.warn(
      { messageId, senderPhone },
      '⛔ Unauthorized access attempt to Manager Bot'
    );
    if (senderPhone) {
      try {
        await evolution.sendTextMessage(
          instance || env.MANAGER_INSTANCE_NAME,
          senderPhone,
          '⛔ *Access Denied*\nThis Manager Assistant is strictly restricted to the authorized store owner.'
        );
      } catch (err: unknown) {
        log.warn({ err }, 'Failed to send unauthorized notice');
      }
    }
    return;
  }

  // 2. Extract natural language text query
  const textContent = (
    messageContent.conversation || messageContent.extendedTextMessage?.text
  )?.trim();

  if (!textContent) {
    log.info({ messageId }, 'Non-text message received on manager bot, ignoring');
    return;
  }

  await executeManagerQuery({
    question: textContent,
    senderPhone,
    instance: instance || env.MANAGER_INSTANCE_NAME,
    log,
  });
}

export async function managerRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions
): Promise<void> {
  fastify.post('/webhook/manager', async (request: FastifyRequest, reply: FastifyReply) => {
    const payload = request.body as EvolutionWebhookPayload;

    // Ignore missing payload or status check events
    if (!payload || !payload.data) {
      return reply.code(200).send({ status: 'ignored', reason: 'empty_payload' });
    }

    // Ignore messages sent by the bot itself (echo events)
    if (payload.data.key?.fromMe) {
      return reply.code(200).send({ status: 'ignored', reason: 'from_me' });
    }

    const messageId = payload.data.key?.id || 'unknown';

    // 1. Immediately acknowledge with HTTP 200 OK
    reply.code(200).send({
      status: 'received',
      messageId,
      timestamp: Date.now(),
    });

    // 2. Offload processing to background execution (non-blocking)
    setImmediate(() => {
      processInboundManagerMessage(payload, fastify.log).catch((err) => {
        fastify.log.error(
          { messageId, err: err instanceof Error ? err.message : String(err) },
          'Unhandled error in background manager pipeline'
        );
      });
    });
  });
}

