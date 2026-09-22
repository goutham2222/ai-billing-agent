import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { EvolutionWebhookPayload } from '../../types/evolution.js';
import { offloadMediaToSupabase } from './bridge.js';

/**
 * Background pipeline to process billing messages asynchronously
 * without delaying the webhook HTTP response.
 */
async function processInboundBillingMessage(
  payload: EvolutionWebhookPayload,
  log: FastifyInstance['log']
): Promise<void> {
  const { event, instance, data } = payload;
  const messageId = data?.key?.id;
  const sender = data?.key?.remoteJid;
  const messageContent = data?.message;

  log.info({ event, instance, messageId, sender }, '🔄 Processing billing webhook payload in background');

  if (!messageContent) {
    log.debug({ messageId }, 'No message content found, skipping');
    return;
  }

  // 1. Offload binary media to Supabase Storage if message is an image, audio, or document
  if (
    messageContent.imageMessage ||
    messageContent.audioMessage ||
    messageContent.documentMessage
  ) {
    try {
      log.info({ messageId, instance }, '⏳ Initiating media offload to Supabase Storage...');
      const media = await offloadMediaToSupabase(instance, messageContent, messageId);

      if (media) {
        log.info(
          {
            messageId,
            mediaType: media.mediaType,
            mimeType: media.mimeType,
            storagePath: media.storagePath,
            storageUrl: media.storageUrl,
            sizeBytes: media.buffer.length,
          },
          '✅ Media successfully persisted to Supabase Storage'
        );

        // TODO [Stage 2]: Forward media.buffer & media.storageUrl to Gemini 1.5 Flash ingestion
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ messageId, error: errMsg }, '❌ Failed to offload media to Supabase Storage');
    }
  } else if (messageContent.conversation || messageContent.extendedTextMessage?.text) {
    const textContent =
      messageContent.conversation || messageContent.extendedTextMessage?.text;
    log.info({ messageId, textContent }, '📝 Received text billing message');

    // TODO [Stage 2]: Forward textContent to Gemini 1.5 Flash ingestion
  } else if (
    messageContent.buttonsResponseMessage ||
    messageContent.templateButtonReplyMessage
  ) {
    log.info({ messageId }, '🔘 Received interactive button reply');

    // TODO [Stage 3]: Forward button click to pending_actions state engine
  }
}

export async function billingRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions
): Promise<void> {
  fastify.post('/webhook/billing', async (request: FastifyRequest, reply: FastifyReply) => {
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
      processInboundBillingMessage(payload, fastify.log).catch((err) => {
        fastify.log.error(
          { messageId, err: err instanceof Error ? err.message : String(err) },
          'Unhandled error in background billing pipeline'
        );
      });
    });
  });
}
