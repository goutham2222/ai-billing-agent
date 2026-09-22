import { executeReadonlyQuery } from '../../lib/db-readonly.js';
import { generatePlainText } from '../../lib/gemini.js';

export interface ExecuteAndFormatParams {
  question: string;
  sql: string;
  explanation?: string;
}

const FORMATTER_SYSTEM_INSTRUCTION = `
You are an executive AI Business Analyst delivering insights to a retail store owner via WhatsApp.
You will receive:
1. The Store Owner's Question (may be in English, Telugu, Hindi, or Hinglish)
2. The SQL Query Executed
3. The Raw Query Result (JSON rows)

YOUR TASK:
Synthesize the query results into a clear, concise, WhatsApp-friendly summary.

GUIDELINES:
1. Formatting:
   - Use bold headers with relevant emojis (e.g. 📊 *Today's Revenue*, 💰 *Udhaar Summary*, 👤 *Customer Ledger*).
   - Format all money values with the Rupee symbol and commas (e.g., ₹1,500, ₹24,000).
   - Use clean bullet points: "• Ramesh: ₹1,200 (2 bills)".
   - If there is a key total or KPI, highlight it prominently at the top.
2. Language Matching:
   - Always reply in the SAME language as the owner's question.
   - If the question was in Telugu (e.g. "ఈరోజు ఎంత అమ్మకాలు అయ్యాయి?"), answer in Telugu!
   - If in Hindi (e.g. "आज कितनी सेल हुई?"), answer in Hindi!
   - If in English, answer in English.
3. Edge Cases:
   - If rows array is empty (0 results):
     Politely explain in the matching language that no records were found matching the criteria (e.g., "ℹ️ ఈరోజు ఎటువంటి బిల్లులు లేవు" or "ℹ️ No bills or pending debts found for this period.").
   - Do NOT dump raw JSON or SQL query syntax to the owner unless asked. Keep it executive, clean, and mobile-friendly.
`;

/**
 * Fallback deterministic formatter in case AI summarizer is temporarily unreachable.
 */
function deterministicFallbackFormat(
  question: string,
  rows: Record<string, unknown>[]
): string {
  if (!rows || rows.length === 0) {
    return `ℹ️ No records found matching "${question}".`;
  }

  const lines: string[] = [`📊 *Results for: "${question}"*`, ''];

  for (const row of rows.slice(0, 15)) {
    const parts = Object.entries(row)
      .map(([k, v]) => {
        if (v === null || v === undefined) return null;
        if (
          typeof v === 'number' ||
          (typeof v === 'string' && !isNaN(Number(v)) && (k.includes('amount') || k.includes('debt') || k.includes('sales') || k.includes('total')))
        ) {
          return `${k}: ₹${Number(v).toLocaleString('en-IN')}`;
        }
        return `${k}: ${v}`;
      })
      .filter(Boolean);

    lines.push(`• ${parts.join(' | ')}`);
  }

  if (rows.length > 15) {
    lines.push(`\n_...and ${rows.length - 15} more records._`);
  }

  return lines.join('\n');
}

/**
 * Executes a sanitized SQL query against Supabase PostgreSQL and formats
 * the output into a WhatsApp-ready conversational summary.
 */
export async function executeAndFormatQuery(
  params: ExecuteAndFormatParams
): Promise<string> {
  const { question, sql, explanation } = params;

  // 1. Execute SQL query against read-only pool
  const rows = await executeReadonlyQuery<Record<string, unknown>>(sql);

  // 2. Synthesize conversational summary via Gemini
  try {
    const promptContent = `
Owner Question: "${question}"
Executed SQL:
${sql}
Explanation: ${explanation || 'N/A'}

Query Results (${rows.length} rows):
${JSON.stringify(rows, null, 2)}
`;

    const summary = await generatePlainText({
      systemInstruction: FORMATTER_SYSTEM_INSTRUCTION,
      contents: [
        {
          role: 'user',
          parts: [{ text: promptContent }],
        },
      ],
      temperature: 0.2,
    });

    if (summary && summary.trim().length > 0) {
      return summary.trim();
    }
  } catch (err: unknown) {
    console.warn(
      '[Manager Executor] Gemini response formatting failed, falling back to deterministic template:',
      err instanceof Error ? err.message : String(err)
    );
  }

  // 3. Fallback deterministic format
  return deterministicFallbackFormat(question, rows);
}
