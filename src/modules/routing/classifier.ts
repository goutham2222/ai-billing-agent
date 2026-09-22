/**
 * Unified intent classifier to distinguish manager business intelligence queries
 * from retail billing entries on a single shared WhatsApp bot account.
 */

// 1. Fast trigger prefixes
const PREFIX_REGEX = /^(\?|\/|!|query:)\s*/i;

// 2. Linguistic question starters and analytical keywords
const ENGLISH_QUERY_REGEX =
  /^(who|what|how much|how many|show|list|total|sales|revenue|summary|report)\b/i;

const HINGLISH_QUERY_REGEX =
  /^(kiska|kitna|kitne|aaj ka|kul|hisaab)\b/i;

const TELUGU_QUERY_REGEX =
  /^(evaru|enta|mottham|ammakaalu|hisaab|baaki evaru)\b/i;

const TELUGU_UNICODE_QUERY_REGEX =
  /^(ఎవరు|ఎంత|మొత్తం|అమ్మకాలు|బాకీ|లెక్క)\b/i;

const HINDI_UNICODE_QUERY_REGEX =
  /^(किसका|कितना|कितने|आज|कुल|बिक्री|हिसाब|उधार)\b/i;

// 3. Trailing question mark
const TRAILING_QUESTION_MARK_REGEX = /\?$/;

/**
 * Checks whether a text message is an analytical Manager Bot query.
 */
export function isManagerQuery(rawText: string): boolean {
  if (!rawText) return false;
  const text = rawText.trim();
  if (text.length === 0) return false;

  // 1. Fast prefix check: begins with ?, /, !, or query:
  if (PREFIX_REGEX.test(text)) {
    return true;
  }

  // 2. Trailing question mark check
  if (TRAILING_QUESTION_MARK_REGEX.test(text)) {
    return true;
  }

  // 3. Linguistic & keyword regex patterns
  if (
    ENGLISH_QUERY_REGEX.test(text) ||
    HINGLISH_QUERY_REGEX.test(text) ||
    TELUGU_QUERY_REGEX.test(text) ||
    TELUGU_UNICODE_QUERY_REGEX.test(text) ||
    HINDI_UNICODE_QUERY_REGEX.test(text)
  ) {
    return true;
  }

  return false;
}

/**
 * Strips leading command trigger symbols (?, /, !, query:) from query text.
 */
export function cleanManagerQuery(rawText: string): string {
  if (!rawText) return '';
  const trimmed = rawText.trim();
  return trimmed.replace(PREFIX_REGEX, '').trim() || trimmed;
}

// 4. Customer Udhaar reminder commands
const REMINDER_REGEX = /^(?:send\s+reminder\s+to|remind\s*:?|reminder\s+for)\b/i;

/**
 * Checks whether a text message is a command to send an Udhaar payment reminder to a customer.
 */
export function isReminderCommand(rawText: string): boolean {
  if (!rawText) return false;
  return REMINDER_REGEX.test(rawText.trim());
}


