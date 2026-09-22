import { GoogleGenAI, ContentListUnion } from '@google/genai';
import { env } from '../config/env.js';

/**
 * Google Gen AI SDK client initialized with the application Gemini API key.
 */
export const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

export interface StructuredGenerationParams {
  model?: string;
  systemInstruction?: string;
  contents: ContentListUnion;
  temperature?: number;
}

/**
 * Helper with exponential backoff and fallback models to execute a Gemini call
 * with enforced structured JSON output.
 */
export async function generateStructuredJson<T>(
  params: StructuredGenerationParams
): Promise<T> {
  const candidateModels = [
    params.model,
    env.GEMINI_MODEL,
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
  ].filter((m, i, arr): m is string => Boolean(m) && arr.indexOf(m) === i);

  let lastError: unknown;

  for (const model of candidateModels) {
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const response = await ai.models.generateContent({
          model,
          contents: params.contents,
          config: {
            responseMimeType: 'application/json',
            systemInstruction: params.systemInstruction,
            temperature: params.temperature ?? 0.1,
          },
        });

        const text = response.text;
        if (!text) {
          throw new Error(`Gemini (${model}) returned an empty response`);
        }

        // Strip markdown fences if returned
        const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
        return JSON.parse(cleaned) as T;
      } catch (err: unknown) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);

        // If deprecated/not found model (404), break to next candidate model immediately
        if (errMsg.includes('404') || errMsg.includes('NOT_FOUND')) {
          break;
        }

        // If rate limit (429) or high demand (503), wait briefly before retrying
        if ((errMsg.includes('503') || errMsg.includes('429')) && attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
          continue;
        }

        // Other errors, try next model candidate
        break;
      }
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Failed to generate structured JSON from Gemini across models: ${msg}`);
}
