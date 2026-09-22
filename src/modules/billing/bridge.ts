import { supabase } from '../../lib/supabase.js';
import { evolution } from '../../lib/evolution.js';
import { env } from '../../config/env.js';
import { EvolutionMessageContent } from '../../types/evolution.js';

export interface OffloadedMedia {
  storagePath: string;
  storageUrl: string;
  mimeType: string;
  buffer: Buffer;
  fileName: string;
  mediaType: 'image' | 'audio' | 'document';
}

function getExtension(mimeType: string): string {
  const cleanMime = mimeType.split(';')[0]?.trim().toLowerCase() || '';
  switch (cleanMime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'audio/ogg':
    case 'audio/opus':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/m4a':
      return 'm4a';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

function cleanMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
}

/**
 * Offloads WhatsApp media directly from Evolution API to Supabase Storage
 * before temporary WhatsApp CDN media URLs expire.
 */
export async function offloadMediaToSupabase(
  instance: string,
  messageContent: EvolutionMessageContent,
  messageId: string
): Promise<OffloadedMedia | null> {
  let detectedType: 'image' | 'audio' | 'document' | null = null;
  let rawMime = 'application/octet-stream';

  if (messageContent.imageMessage) {
    detectedType = 'image';
    rawMime = messageContent.imageMessage.mimetype || 'image/jpeg';
  } else if (messageContent.audioMessage) {
    detectedType = 'audio';
    rawMime = messageContent.audioMessage.mimetype || 'audio/ogg';
  } else if (messageContent.documentMessage) {
    detectedType = 'document';
    rawMime = messageContent.documentMessage.mimetype || 'application/pdf';
  }

  if (!detectedType) {
    return null; // Not a media message
  }

  const mimeType = cleanMimeType(rawMime);
  const extension = getExtension(mimeType);

  // 1. Fetch decrypted base64 from Evolution API
  const { base64 } = await evolution.getBase64FromMediaMessage(instance, messageContent);
  const buffer = Buffer.from(base64, 'base64');

  // 2. Generate deterministic storage path in Supabase
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const fileName = `${messageId}-${Date.now()}.${extension}`;
  const storagePath = `bills/${year}/${month}/${fileName}`;

  // 3. Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Supabase Storage upload failed: ${uploadError.message}`);
  }

  // 4. Retrieve public URL
  const { data: publicUrlData } = supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .getPublicUrl(storagePath);

  const storageUrl = publicUrlData.publicUrl;

  return {
    storagePath,
    storageUrl,
    mimeType,
    buffer,
    fileName,
    mediaType: detectedType,
  };
}
