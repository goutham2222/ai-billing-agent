import { generateStructuredJson } from '../../lib/gemini.js';
import { POSTGRES_SCHEMA_DDL, BUSINESS_RULES_CONTEXT } from './schema-context.js';

export interface SqlGenerationResult {
  sql: string;
  explanation: string;
}

export interface SqlValidationResult {
  isValid: boolean;
  sanitizedSql?: string;
  reason?: string;
}

/**
 * Validates and sanitizes a generated SQL query against strict read-only guardrails.
 */
export function validateAndSanitizeSql(rawSql: string): SqlValidationResult {
  if (!rawSql || typeof rawSql !== 'string') {
    return { isValid: false, reason: 'Empty or non-string SQL query' };
  }

  // 1. Strip markdown fences and whitespace
  let sql = rawSql
    .replace(/^```(?:sql)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // 2. Strip single-line and multi-line comments to avoid parser bypass
  sql = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();

  if (!sql) {
    return { isValid: false, reason: 'SQL query became empty after removing comments' };
  }

  // 3. Strip trailing semicolons
  while (sql.endsWith(';')) {
    sql = sql.slice(0, -1).trim();
  }

  // 4. Reject multi-statement delimiters (unquoted semicolon)
  if (sql.includes(';')) {
    return {
      isValid: false,
      reason: 'Multi-statement SQL queries are strictly prohibited',
    };
  }

  // 5. Must start with SELECT or WITH
  const startsWithSelectOrWith = /^(SELECT|WITH)\b/i.test(sql);
  if (!startsWithSelectOrWith) {
    return {
      isValid: false,
      reason: 'Only SELECT or CTE (WITH ... SELECT) queries are allowed',
    };
  }

  // 6. Blacklist of forbidden SQL DML/DDL/Administrative keywords
  const forbiddenKeywords = [
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'ALTER',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'CREATE',
    'REPLACE',
    'EXECUTE',
    'EXEC',
    'COPY',
    'CALL',
    'LOCK',
    'VACUUM',
    'DO',
    'REINDEX',
    'REFRESH',
    'SET',
    'RESET',
    'DISCARD',
  ];

  for (const kw of forbiddenKeywords) {
    const kwRegex = new RegExp(`\\b${kw}\\b`, 'i');
    if (kwRegex.test(sql)) {
      return {
        isValid: false,
        reason: `Query contains prohibited SQL keyword: ${kw}`,
      };
    }
  }

  // 7. Reject attempts to query internal Postgres system catalogs or sensitive schemas
  const internalSchemaRegex =
    /\b(information_schema|pg_catalog|pg_[a-zA-Z0-9_]+|auth\.|storage\.|vault\.|extensions\.)\b/i;
  if (internalSchemaRegex.test(sql)) {
    return {
      isValid: false,
      reason: 'Access to internal system catalogs or security schemas is forbidden',
    };
  }

  // 8. Clamp or append LIMIT
  const limitMatch = sql.match(/\bLIMIT\s+(\d+)\b/i);
  if (limitMatch && limitMatch[1]) {
    const requestedLimit = parseInt(limitMatch[1], 10);
    if (requestedLimit > 100) {
      sql = sql.replace(/\bLIMIT\s+\d+\b/i, 'LIMIT 100');
    }
  } else {
    // If not a pure single-row aggregation without group by, append LIMIT 50
    const isScalarAgg =
      /SELECT\s+(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sql) &&
      !/\bGROUP\s+BY\b/i.test(sql);
    if (!isScalarAgg) {
      sql = `${sql} LIMIT 50`;
    }
  }

  return {
    isValid: true,
    sanitizedSql: sql,
  };
}

const SYSTEM_INSTRUCTION = `
You are an expert PostgreSQL Text-to-SQL business intelligence analyst for a WhatsApp CRM system.
Your job is to convert natural language store queries into accurate, strictly READ-ONLY PostgreSQL queries.

${POSTGRES_SCHEMA_DDL}

${BUSINESS_RULES_CONTEXT}

STRICT INSTRUCTIONS:
1. Always output valid JSON matching this schema:
   {
     "sql": "string (the PostgreSQL SELECT query)",
     "explanation": "string (brief explanation of what the query calculates)"
   }
2. Output ONLY the JSON object. Do not wrap in markdown or add extraneous conversational text.
3. The SQL MUST be a single, valid PostgreSQL SELECT statement.
4. Support queries in English, Telugu, Hindi, or Hinglish (e.g. "ఈరోజు అమ్మకాలు ఎంత?", "कल का कुल उधारी कितना है?", "Who owes more than 1000 rupees?").
5. Only query public schema tables: customers, bills, pending_actions.
6. Cancelled bills (payment_status = 'cancelled') must ALWAYS be excluded from revenue/sales calculations.
7. Use ILIKE for case-insensitive customer name matching.
`;

/**
 * Converts a manager's natural language question into a sanitized read-only PostgreSQL query.
 */
export async function generateSqlFromQuestion(
  question: string
): Promise<SqlGenerationResult> {
  const result = await generateStructuredJson<SqlGenerationResult>({
    systemInstruction: SYSTEM_INSTRUCTION,
    contents: [
      {
        role: 'user',
        parts: [{ text: `Store Manager Question: "${question}"` }],
      },
    ],
    temperature: 0.1,
  });

  if (!result || !result.sql) {
    throw new Error('Gemini failed to generate SQL query');
  }

  // Run through strict guardrails
  const validation = validateAndSanitizeSql(result.sql);
  if (!validation.isValid || !validation.sanitizedSql) {
    throw new Error(
      `Generated SQL failed safety validation: ${validation.reason || 'Unknown guardrail violation'}`
    );
  }

  return {
    sql: validation.sanitizedSql,
    explanation: result.explanation || 'Analytics query executed',
  };
}

