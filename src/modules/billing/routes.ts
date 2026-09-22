import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { EvolutionWebhookPayload } from '../../types/evolution.js';
import { offloadMediaToSupabase } from './bridge.js';
import { extractBillFromMedia } from './extractor.js';
import {
  createDraftAndPendingAction,
  sendConfirmationButtons,
  handleButtonConfirmation,
} from './state.js';
import { env } from '../../config/env.js';
import { supabase } from '../../lib/supabase.js';

/**
 * Background pipeline to process billing messages asynchronously
 * without delaying the webhook HTTP response.
 */
async function processInboundBillingMessage(
  payload: EvolutionWebhookPayload,
  log: FastifyInstance['log']
): Promise<void> {
  const { event, instance, data } = payload;
  const messageId = data?.key?.id || `msg-${Date.now()}`;
  const sender = data?.key?.remoteJid;
  const messageContent = data?.message;

  log.info({ event, instance, messageId, sender }, '🔄 Processing billing webhook payload in background');

  if (!messageContent) {
    log.debug({ messageId }, 'No message content found, skipping');
    return;
  }

  const senderPhone = sender ? sender.replace(/[^0-9]/g, '') : (env.STORE_OWNER_PHONE || '');
  const ownerPhone = env.STORE_OWNER_PHONE || senderPhone;

  // 1. Check for interactive WhatsApp button reply events
  const msgAny = messageContent as Record<string, any>;
  const selectedButtonId =
    messageContent.buttonsResponseMessage?.selectedButtonId ||
    messageContent.templateButtonReplyMessage?.selectedId ||
    msgAny['buttons_response']?.selectedButtonId ||
    msgAny['interactiveResponseMessage']?.buttonReply?.id;

  if (typeof selectedButtonId === 'string' && selectedButtonId.startsWith('action_')) {
    log.info({ messageId, selectedButtonId, senderPhone }, '🔘 Received interactive button reply, resolving state...');
    try {
      const result = await handleButtonConfirmation({
        selectedButtonId,
        senderPhone: ownerPhone,
      });
      log.info({ messageId, result }, '✅ Button confirmation resolved successfully');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ messageId, error: errMsg }, '❌ Failed to resolve button confirmation');
    }
    return;
  }

  // 2. Offload binary media to Supabase Storage if message is an image, audio, or document
  if (
    messageContent.imageMessage ||
    messageContent.audioMessage ||
    messageContent.documentMessage
  ) {
    try {
      log.info({ messageId, instance }, '⏳ Initiating media offload to Supabase Storage...');
      const media = await offloadMediaToSupabase(instance, data);

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

        // Stage 2: Multimodal Gemini extraction
        log.info({ messageId }, '🧠 Starting Gemini multimodal bill extraction...');
        const extractedBill = await extractBillFromMedia({
          buffer: media.buffer,
          mimeType: media.mimeType,
          text: messageContent.imageMessage?.caption,
        });

        log.info(
          {
            messageId,
            customer: extractedBill.customer,
            totalAmount: extractedBill.totalAmount,
            paymentStatus: extractedBill.paymentStatus,
            detectedLanguage: extractedBill.detectedLanguage,
            itemsCount: extractedBill.items.length,
          },
          '🎉 Bill successfully extracted from media'
        );

        // Stage 3: Persist draft bill & pending_action in Supabase
        log.info({ messageId, ownerPhone }, '💾 Persisting customer, draft bill, and pending action...');
        const { bill, pendingAction } = await createDraftAndPendingAction({
          extractedBill,
          mediaUrl: media.storageUrl,
          rawMessageId: messageId,
          ownerPhone,
        });

        // Stage 3: Send confirmation buttons to store owner
        if (ownerPhone) {
          log.info({ messageId, ownerPhone, billId: bill.id }, '📤 Sending WhatsApp confirmation buttons to owner...');
          await sendConfirmationButtons({
            ownerPhone,
            bill,
            pendingActionId: pendingAction.whatsapp_message_id,
            extractedBill,
          });
          log.info({ messageId, ownerPhone }, '✅ Confirmation buttons successfully dispatched');
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ messageId, error: errMsg }, '❌ Failed to process multimodal billing message');
    }
  } else if (messageContent.conversation || messageContent.extendedTextMessage?.text) {
    const textContent = (
      messageContent.conversation || messageContent.extendedTextMessage?.text
    )?.trim();

    if (!textContent) return;

    log.info({ messageId, textContent }, '📝 Received text billing message');

    // Check if the text is a shorthand reply to a pending confirmation (e.g. "1", "2", "paid", "udhaar")
    const lowerText = textContent.toLowerCase();
    if (['1', '2', '3', 'paid', 'udhaar', 'cancel'].includes(lowerText)) {
      const { data: latestPending } = await supabase
        .from('pending_actions')
        .select('*')
        .eq('owner_phone', ownerPhone)
        .eq('status', 'awaiting_confirmation')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestPending) {
        const choice =
          lowerText === '1' || lowerText === 'paid'
            ? 'paid'
            : lowerText === '2' || lowerText === 'udhaar'
            ? 'pending'
            : 'reject';

        log.info(
          { messageId, choice, actionId: latestPending.whatsapp_message_id },
          '🔘 Resolving pending bill action via text shorthand'
        );

        await handleButtonConfirmation({
          selectedButtonId: `action_${choice}_${latestPending.whatsapp_message_id}`,
          senderPhone: ownerPhone,
        });
        return;
      }
    }

    try {
      // Stage 2: Text Gemini extraction
      log.info({ messageId }, '🧠 Starting Gemini text bill extraction...');
      const extractedBill = await extractBillFromMedia({
        text: textContent,
        mimeType: 'text/plain',
      });

      log.info(
        {
          messageId,
          customer: extractedBill.customer,
          totalAmount: extractedBill.totalAmount,
          paymentStatus: extractedBill.paymentStatus,
          detectedLanguage: extractedBill.detectedLanguage,
          itemsCount: extractedBill.items.length,
        },
        '🎉 Bill successfully extracted from text'
      );

      // Stage 3: Persist draft bill & pending_action in Supabase
      log.info({ messageId, ownerPhone }, '💾 Persisting customer, draft bill, and pending action...');
      const { bill, pendingAction } = await createDraftAndPendingAction({
        extractedBill,
        rawMessageId: messageId,
        ownerPhone,
      });

      // Stage 3: Send confirmation buttons to store owner
      if (ownerPhone) {
        log.info({ messageId, ownerPhone, billId: bill.id }, '📤 Sending WhatsApp confirmation buttons to owner...');
        await sendConfirmationButtons({
          ownerPhone,
          bill,
          pendingActionId: pendingAction.whatsapp_message_id,
          extractedBill,
        });
        log.info({ messageId, ownerPhone }, '✅ Confirmation buttons successfully dispatched');
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ messageId, error: errMsg }, '❌ Failed to process text billing message');
    }
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
