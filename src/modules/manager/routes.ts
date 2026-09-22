import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { EvolutionWebhookPayload } from '../../types/evolution.js';
import { env } from '../../config/env.js';
import { evolution } from '../../lib/evolution.js';
import { generateSqlFromQuestion } from './sql-generator.js';
import { executeAndFormatQuery } from './executor.js';

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
  const ownerPhone = env.STORE_OWNER_PHONE ? env.STORE_OWNER_PHONE.replace(/[^0-9]/g, '') : '';

  // 1. Authorization: Only allow registered store owner to query manager bot
  if (ownerPhone) {
    const ownerLast10 = ownerPhone.slice(-10);
    const senderLast10 = senderPhone.slice(-10);
    const isAuthorized =
      senderPhone === ownerPhone ||
      (ownerLast10.length === 10 && senderLast10 === ownerLast10);

    if (!isAuthorized) {
      log.warn(
        { messageId, senderPhone, ownerPhone },
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
  }

  // 2. Extract natural language text query
  const textContent = (
    messageContent.conversation || messageContent.extendedTextMessage?.text
  )?.trim();

  if (!textContent) {
    log.info({ messageId }, 'Non-text message received on manager bot, ignoring');
    return;
  }

  log.info({ messageId, senderPhone, question: textContent }, '🔍 Processing manager analytics query...');

  try {
    // 3. Generate sanitized read-only SQL via Gemini
    const { sql, explanation } = await generateSqlFromQuestion(textContent);
    log.info({ messageId, sql, explanation }, '⚡ Generated safe SQL query');

    // 4. Execute query & format natural response
    const report = await executeAndFormatQuery({
      question: textContent,
      sql,
      explanation,
    });

    // 5. Send formatted summary back via Evolution API
    await evolution.sendTextMessage(
      instance || env.MANAGER_INSTANCE_NAME,
      senderPhone,
      report
    );

    log.info({ messageId, senderPhone }, '✅ Analytics report successfully dispatched to owner');
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ messageId, error: errMsg }, '❌ Failed to process manager analytics query');

    if (senderPhone) {
      const errorReply = `⚠️ *Analytics Assistant Notice*\n\nUnable to answer: ${errMsg}\n\n_Tip: Try asking questions like "Today's sales", "Who owes udhaar?", or "ఈరోజు అమ్మకాలు ఎంత?"._`;
      try {
        await evolution.sendTextMessage(
          instance || env.MANAGER_INSTANCE_NAME,
          senderPhone,
          errorReply
        );
      } catch (sendErr: unknown) {
        log.warn({ sendErr }, 'Failed to send error notification back to manager');
      }
    }
  }
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

