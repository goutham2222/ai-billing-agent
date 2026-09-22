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

export interface ListRowOption {
  title: string;
  description?: string;
  rowId: string;
}

export interface ListSection {
  title: string;
  rows: ListRowOption[];
}

export interface SendMediaParams {
  number: string;
  mediatype: 'image' | 'video' | 'document' | 'audio';
  mimetype: string;
  media: string; // URL or base64 data
  fileName?: string;
  caption?: string;
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
   * Helper to perform requests with automatic fallback between hyphenated
   * and underscored instance names if a 404 Not Found error is returned.
   */
  private async postWithFallback<T = unknown>(
    pathGenerator: (instance: string) => string,
    instance: string,
    data: unknown
  ): Promise<T> {
    try {
      const response = await this.http.post<T>(pathGenerator(instance), data);
      return response.data;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        // Try alternating hyphens and underscores
        const altInstance = instance.includes('_')
          ? instance.replace(/_/g, '-')
          : instance.includes('-')
          ? instance.replace(/-/g, '_')
          : null;

        if (altInstance && altInstance !== instance) {
          const altResponse = await this.http.post<T>(pathGenerator(altInstance), data);
          return altResponse.data;
        }
      }
      throw err;
    }
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

      const data = await this.postWithFallback<{ base64?: string; mimetype?: string } | string>(
        (inst) => `/chat/getBase64FromMediaMessage/${inst}`,
        instance,
        {
          message: messagePayload,
          convertToMp4: false,
        }
      );

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
    try {
      return await this.postWithFallback(
        (inst) => `/message/sendText/${inst}`,
        instance,
        {
          number: formattedNumber,
          text,
        }
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send WhatsApp text via Evolution API (${instance}): ${msg}`);
    }
  }

  /**
   * Sends interactive list message to a WhatsApp recipient.
   * Evolution API v2 endpoint: POST /message/sendList/{instance}
   */
  async sendList(
    instance: string,
    to: string,
    title: string,
    description: string,
    buttonText: string,
    sections: ListSection[],
    footerText?: string
  ): Promise<unknown> {
    const formattedNumber = to.replace(/[^0-9]/g, '');
    try {
      return await this.postWithFallback(
        (inst) => `/message/sendList/${inst}`,
        instance,
        {
          number: formattedNumber,
          title,
          description,
          buttonText,
          footerText: footerText || 'AI Billing Agent',
          sections,
        }
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send WhatsApp list via Evolution API (${instance}): ${msg}`);
    }
  }

  /**
   * Sends media (image, audio, document) to a WhatsApp recipient.
   * Evolution API v2 endpoint: POST /message/sendMedia/{instance}
   */
  async sendMedia(instance: string, params: SendMediaParams): Promise<unknown> {
    const formattedNumber = params.number.replace(/[^0-9]/g, '');
    try {
      return await this.postWithFallback(
        (inst) => `/message/sendMedia/${inst}`,
        instance,
        {
          ...params,
          number: formattedNumber,
        }
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send WhatsApp media via Evolution API (${instance}): ${msg}`);
    }
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
    try {
      return await this.postWithFallback(
        (inst) => `/message/sendButtons/${inst}`,
        instance,
        {
          number: formattedNumber,
          title,
          description,
          footer: footer || 'AI Billing Agent',
          buttons: buttons.map((b) => ({
            type: 'reply',
            displayText: b.text,
            id: b.id,
          })),
        }
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send WhatsApp buttons via Evolution API (${instance}): ${msg}`);
    }
  }

  /**
   * Sends an interactive native poll message to a WhatsApp recipient.
   * Evolution API v2 endpoint: POST /message/sendPoll/{instance}
   */
  async sendPoll(
    instance: string,
    to: string,
    name: string,
    options: string[],
    selectableCount = 1
  ): Promise<unknown> {
    const formattedNumber = to.replace(/[^0-9]/g, '');
    try {
      return await this.postWithFallback(
        (inst) => `/message/sendPoll/${inst}`,
        instance,
        {
          number: formattedNumber,
          name,
          selectableCount,
          values: options,
        }
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send WhatsApp poll via Evolution API (${instance}): ${msg}`);
    }
  }
}

export const evolution = new EvolutionClient();
