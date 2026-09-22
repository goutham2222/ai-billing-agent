import { Part } from '@google/genai';
import { generateStructuredJson } from '../../lib/gemini.js';
import { ExtractedBill, ExtractedBillSchema } from './schemas.js';

export interface ExtractBillInput {
  buffer?: Buffer;
  mimeType: string;
  text?: string;
}

const BILLING_EXTRACTION_SYSTEM_PROMPT = `
You are an expert AI billing and retail ledger parser for Indian retail, kirana, grocery, and general stores.
You specialize in accurately reading handwritten receipts, printed invoices, voice notes, and shorthand messages in English, Hindi, Telugu, or code-switched phrases (Hinglish/Tanglish).

YOUR TASK:
Extract structured invoice/bill details into the exact JSON format matching the schema below.

JSON SCHEMA STRUCTURE:
{
  "customer": {
    "name": "string (Customer name, defaults to 'Walk-in Customer' if absent)",
    "phone": "string (optional phone number)"
  },
  "items": [
    {
      "name": "string (Item name)",
      "quantity": 1,
      "unit": "string (kg, g, ltr, ml, packet, piece, bottle, etc. or omit if unspecified)",
      "unitPrice": 0,
      "totalPrice": 0
    }
  ],
  "totalAmount": 0,
  "paymentStatus": "'paid' or 'pending'",
  "detectedLanguage": "'en', 'hi', 'te', or 'mixed'",
  "rawTranscriptionOrOcr": "string (Exact verbatim spoken audio transcription or OCR text)",
  "confidenceNotes": "string (Any assumptions or notes regarding illegible writing or slang)"
}

CRITICAL VERNACULAR DEBT MAPPING RULES:
1. paymentStatus:
   - MUST be 'pending' if any debt, credit, or unpaid status is indicated by terms such as:
     - Hindi: "baki", "baaki", "udhaar", "udhar", "udhari", "lena hai", "khatam nahi hua", "baad me dega", "likh lo"
     - Telugu: "ivvali", "ivvalsindi", "baaki", "appu", "udharu", "tharvatha isthadu", "raasi pettu"
     - English: "pending", "due", "credit", "debt", "on account", "unpaid", "balance"
   - MUST be 'paid' if settled or cash terms are used such as:
     - Hindi: "diya", "de diya", "jama", "cash", "nagad", "mil gaya", "chuka diya", "aagaya"
     - Telugu: "ichadu", "icchesadu", "chellinchadu", "nagadu", "vasool aindi"
     - English: "paid", "received", "cleared", "settled", "cash", "done"
   - If payment status is ambiguous or unspecified, default to 'pending'.

2. CUSTOMER IDENTIFICATION:
   - Extract customer name when present (e.g., "Ramesh", "Suresh anna", "Lakshmi garu").
   - Strip casual honorifics (ji, bhai, garu, anna, saab) or keep clean first names.
   - If no customer name is identified, set name to "Walk-in Customer".

3. ACCURATE ARITHMETIC:
   - If only an item price is spoken (e.g. "Rice 120"), assume quantity: 1, totalPrice: 120.
   - Ensure totalAmount equals the sum of all item totalPrices unless an explicit grand total is specified.
   - Numbers must be numeric, not spelled out words.
`.trim();

/**
 * Normalizes and sanitizes raw JSON output from the model to guarantee
 * adherence to the ExtractedBillSchema even if slight discrepancies occur.
 */
function normalizeExtractedData(raw: Record<string, unknown>): ExtractedBill {
  const customerRaw = (typeof raw['customer'] === 'object' && raw['customer'] !== null)
    ? (raw['customer'] as Record<string, unknown>)
    : {};

  const customer = {
    name: typeof customerRaw['name'] === 'string' && customerRaw['name'].trim().length > 0
      ? customerRaw['name'].trim()
      : 'Walk-in Customer',
    phone: typeof customerRaw['phone'] === 'string' && customerRaw['phone'].trim().length > 0
      ? customerRaw['phone'].trim()
      : undefined,
  };

  const rawItems = Array.isArray(raw['items']) ? raw['items'] : [];
  const items = rawItems.map((item: unknown) => {
    const itemObj = (typeof item === 'object' && item !== null)
      ? (item as Record<string, unknown>)
      : {};

    const name = typeof itemObj['name'] === 'string' && itemObj['name'].trim().length > 0
      ? itemObj['name'].trim()
      : 'Item';
    const quantity = Number(itemObj['quantity']) || 1;
    const unit = typeof itemObj['unit'] === 'string' ? itemObj['unit'] : undefined;
    const unitPrice = itemObj['unitPrice'] != null ? Number(itemObj['unitPrice']) : undefined;
    const totalPrice = Number(itemObj['totalPrice']) || (unitPrice ? quantity * unitPrice : 0);

    return {
      name,
      quantity,
      unit,
      unitPrice,
      totalPrice,
    };
  });

  // Calculate items sum
  const itemsSum = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const rawTotal = Number(raw['totalAmount']);
  const totalAmount = !isNaN(rawTotal) && rawTotal > 0 ? rawTotal : itemsSum;

  // Normalize payment status
  const rawStatus = String(raw['paymentStatus'] || '').toLowerCase();
  const paymentStatus: 'paid' | 'pending' =
    rawStatus.includes('paid') || rawStatus === 'cash' || rawStatus === 'settled'
      ? 'paid'
      : 'pending';

  // Normalize detected language
  const rawLang = String(raw['detectedLanguage'] || '').toLowerCase();
  let detectedLanguage: 'en' | 'hi' | 'te' | 'mixed' = 'mixed';
  if (rawLang === 'en' || rawLang === 'english') detectedLanguage = 'en';
  else if (rawLang === 'hi' || rawLang === 'hindi') detectedLanguage = 'hi';
  else if (rawLang === 'te' || rawLang === 'telugu') detectedLanguage = 'te';

  const rawTranscriptionOrOcr = typeof raw['rawTranscriptionOrOcr'] === 'string'
    ? raw['rawTranscriptionOrOcr']
    : '';

  const confidenceNotes = typeof raw['confidenceNotes'] === 'string'
    ? raw['confidenceNotes']
    : undefined;

  return {
    customer,
    items,
    totalAmount,
    paymentStatus,
    detectedLanguage,
    rawTranscriptionOrOcr,
    confidenceNotes,
  };
}

/**
 * Multimodal extraction engine that parses handwritten bills, voice notes,
 * and text messages using Gemini 1.5 Flash.
 */
export async function extractBillFromMedia(input: ExtractBillInput): Promise<ExtractedBill> {
  const contents: (string | Part)[] = [];

  // 1. Attach multimodal binary part if buffer is present
  if (input.buffer) {
    const cleanMime = input.mimeType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
    contents.push({
      inlineData: {
        data: input.buffer.toString('base64'),
        mimeType: cleanMime,
      },
    });
  }

  // 2. Attach text prompt or message content
  let promptText = 'Extract the billing and debt ledger information from this input into the requested JSON schema.';
  if (input.text) {
    promptText += `\n\nText input:\n"${input.text}"`;
  }
  contents.push(promptText);

  // 3. Call Gemini with enforced structured JSON
  const rawResult = await generateStructuredJson<Record<string, unknown>>({
    model: 'gemini-1.5-flash',
    systemInstruction: BILLING_EXTRACTION_SYSTEM_PROMPT,
    contents,
    temperature: 0.1,
  });

  // 4. Validate with Zod
  const validation = ExtractedBillSchema.safeParse(rawResult);
  if (validation.success) {
    return validation.data;
  }

  // 5. Fallback: normalize and re-validate if minor formatting anomalies exist
  const normalized = normalizeExtractedData(rawResult);
  return ExtractedBillSchema.parse(normalized);
}
