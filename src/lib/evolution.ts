import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env.js';

export interface Base64MediaResponse {
  base64: string;
  mimetype: string;
}

export interface ButtonOption {
  id: string;
  text: string;
}

export class EvolutionClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: env.EVOLUTION_API_URL,
      headers: {
        apikey: env.EVOLUTION_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * Fetches base64 binary buffer for an encrypted WhatsApp media message.
   * Evolution API v2 requires the full message object (including `key` and `message` contents)
   * in the request body: `{ message: rawMessageObject, convertToMp4: false }`.
   */
  async getBase64FromMediaMessage(
    instance: string,
    rawMessage: unknown
  ): Promise<Base64MediaResponse> {
    try {
      // Normalize message payload to ensure `{ key, message }` structure is forwarded
      const messagePayload =
        typeof rawMessage === 'object' &&
        rawMessage !== null &&
        'message' in rawMessage &&
        typeof (rawMessage as Record<string, unknown>).message === 'object' &&
        (rawMessage as Record<string, unknown>).message !== null &&
        'key' in ((rawMessage as Record<string, unknown>).message as Record<string, unknown>)
          ? (rawMessage as Record<string, unknown>).message
          : rawMessage;

      const response = await this.http.post(`/chat/getBase64FromMediaMessage/${instance}`, {
        message: messagePayload,
        convertToMp4: false,
      });

      const data = response.data as { base64?: string; mimetype?: string } | string;

      if (typeof data === 'string') {
        return {
          base64: data,
          mimetype: 'application/octet-stream',
        };
      }

      if (data && typeof data.base64 === 'string') {
        return {
          base64: data.base64,
          mimetype: data.mimetype || 'application/octet-stream',
        };
      }

      throw new Error('Evolution API did not return base64 data');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch media base64 from Evolution API (${instance}): ${msg}`);
    }
  }

  /**
   * Sends a plain text message to a WhatsApp number/JID.
   */
  async sendTextMessage(instance: string, to: string, text: string): Promise<unknown> {
    const formattedNumber = to.replace(/[^0-9]/g, '');
    const response = await this.http.post(`/message/sendText/${instance}`, {
      number: formattedNumber,
      text,
    });
    return response.data;
  }

  /**
   * Sends interactive buttons message to a WhatsApp recipient.
   */
  async sendButtons(
    instance: string,
    to: string,
    title: string,
    description: string,
    buttons: ButtonOption[],
    footer?: string
  ): Promise<unknown> {
    const formattedNumber = to.replace(/[^0-9]/g, '');
    const response = await this.http.post(`/message/sendButtons/${instance}`, {
      number: formattedNumber,
      title,
      description,
      footer: footer || 'AI Billing Agent',
      buttons: buttons.map((b) => ({
        type: 'reply',
        displayText: b.text,
        id: b.id,
      })),
    });
    return response.data;
  }
}

export const evolution = new EvolutionClient();
