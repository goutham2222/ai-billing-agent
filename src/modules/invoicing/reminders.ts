import { supabase } from '../../lib/supabase.js';
import { evolution } from '../../lib/evolution.js';

export interface ReminderParams {
  rawCommand: string;
  ownerPhone: string;
  instance: string;
}

export interface ReminderResult {
  success: boolean;
  message: string;
}

/**
 * Extracts target customer name from natural command variations like:
 * "remind Ramesh", "send reminder to Suresh", "reminder for Mahesh"
 */
export function extractCustomerNameFromReminderCommand(command: string): string {
  const match = command.match(
    /^(?:send\s+reminder\s+to|remind\s*:?|reminder\s+for)\s+(.+)$/i
  );
  return match && match[1] ? match[1].trim() : command.trim();
}

/**
 * Handles owner command to send a polite WhatsApp payment reminder to a customer with pending udhaar.
 */
export async function handleCustomerReminder(
  params: ReminderParams
): Promise<ReminderResult> {
  const { rawCommand, ownerPhone, instance } = params;
  const targetName = extractCustomerNameFromReminderCommand(rawCommand);

  if (!targetName || targetName.length < 2) {
    const errorMsg = '⚠️ Please specify a valid customer name (e.g., "remind Ramesh" or "send reminder to Suresh").';
    await evolution.sendTextMessage(instance, ownerPhone, errorMsg);
    return { success: false, message: errorMsg };
  }

  // 1. Search customer by name in customers table
  const { data: matchedCustomers, error: custErr } = await supabase
    .from('customers')
    .select('id, name, phone, preferred_language')
    .ilike('name', `%${targetName}%`)
    .limit(5);

  if (custErr || !matchedCustomers || matchedCustomers.length === 0) {
    const notFoundMsg = `⚠️ No customer found matching "*${targetName}*". Please verify the customer name.`;
    await evolution.sendTextMessage(instance, ownerPhone, notFoundMsg);
    return { success: false, message: notFoundMsg };
  }

  const customer = matchedCustomers[0];
  if (!customer) {
    const notFoundMsg = `⚠️ No customer found matching "*${targetName}*". Please verify the customer name.`;
    await evolution.sendTextMessage(instance, ownerPhone, notFoundMsg);
    return { success: false, message: notFoundMsg };
  }

  // 2. Fetch all pending bills for this customer
  const { data: pendingBills, error: billsErr } = await supabase
    .from('bills')
    .select('id, bill_no, total_amount, created_at')
    .eq('customer_id', customer.id)
    .eq('payment_status', 'pending');

  if (billsErr) {
    const dbErr = `❌ Failed to query customer debt records: ${billsErr.message}`;
    await evolution.sendTextMessage(instance, ownerPhone, dbErr);
    return { success: false, message: dbErr };
  }

  if (!pendingBills || pendingBills.length === 0) {
    const zeroDebtMsg = `ℹ️ Customer *${customer.name}* does not have any pending udhaar dues! All bills are settled.`;
    await evolution.sendTextMessage(instance, ownerPhone, zeroDebtMsg);
    return { success: true, message: zeroDebtMsg };
  }

  // 3. Calculate total debt and bill numbers
  const totalDebt = pendingBills.reduce((sum, b) => sum + Number(b.total_amount || 0), 0);
  const billCount = pendingBills.length;
  const billNumbersList = pendingBills
    .filter((b) => Boolean(b.bill_no))
    .map((b) => `#${b.bill_no}`)
    .slice(0, 5)
    .join(', ');

  const billReference = billNumbersList ? ` (Bills: ${billNumbersList})` : '';

  // 4. Verify customer phone number
  const cleanPhone = customer.phone ? customer.phone.replace(/[^0-9]/g, '') : '';
  const isWalkinPlaceholder = !cleanPhone || cleanPhone.length < 10 || customer.phone.startsWith('walkin-');

  if (isWalkinPlaceholder) {
    const noPhoneMsg = `⚠️ *Reminder Failed*: Customer *${customer.name}* has *Rs. ${totalDebt.toLocaleString('en-IN')}* pending udhaar, but has no valid registered WhatsApp phone number (${customer.phone}).`;
    await evolution.sendTextMessage(instance, ownerPhone, noPhoneMsg);
    return { success: false, message: noPhoneMsg };
  }

  // 5. Compose polite, localized reminder message
  let reminderMessage: string;
  const prefLang = (customer.preferred_language || '').toLowerCase();

  if (prefLang.includes('telugu') || prefLang === 'te') {
    reminderMessage =
      `🙏 *చెల్లింపు రిమైండర్ (Payment Reminder)*\n\n` +
      `నమస్కారం *${customer.name}* గారు,\n` +
      `మా దుకాణంలో మీ పెండింగ్ బాకీ మొత్తం *రూ. ${totalDebt.toLocaleString('en-IN')}*${billReference}.\n\n` +
      `దయచేసి వీలైనంత త్వరగా చెల్లించగలరు. ఏదైనా సందేహం ఉంటే సంప్రదించండి.\n` +
      `ధన్యవాదాలు!`;
  } else if (prefLang.includes('hindi') || prefLang === 'hi') {
    reminderMessage =
      `🙏 *भुगतान अनुस्मारक (Payment Reminder)*\n\n` +
      `नमस्ते *${customer.name}* जी,\n` +
      `हमारी दुकान पर आपका कुल बकाया उधार *रु. ${totalDebt.toLocaleString('en-IN')}*${billReference} है।\n\n` +
      `कृपया अपनी सुविधानुसार भुगतान करने का कष्ट करें।\n` +
      `धन्यवाद!`;
  } else {
    reminderMessage =
      `🙏 *Payment Reminder*\n\n` +
      `Dear *${customer.name}*,\n` +
      `This is a gentle reminder regarding your pending balance of *Rs. ${totalDebt.toLocaleString('en-IN')}* across ${billCount} bill(s)${billReference}.\n\n` +
      `Kindly clear the due amount at your convenience.\n` +
      `Thank you for your business!`;
  }

  // 6. Send WhatsApp reminder to the customer
  try {
    await evolution.sendTextMessage(instance, cleanPhone, reminderMessage);
  } catch (err: unknown) {
    const sendErrMsg = `⚠️ Failed to send reminder to customer's WhatsApp: ${err instanceof Error ? err.message : String(err)}`;
    await evolution.sendTextMessage(instance, ownerPhone, sendErrMsg);
    return { success: false, message: sendErrMsg };
  }

  // 7. Confirm back to store owner
  const confirmationMsg =
    `✅ *Reminder Sent Successfully*\n` +
    `👤 Customer: *${customer.name}*\n` +
    `📱 Phone: *${customer.phone}*\n` +
    `💰 Pending Udhaar: *Rs. ${totalDebt.toLocaleString('en-IN')}* (${billCount} bills)\n` +
    `🌐 Language: *${customer.preferred_language || 'English'}*`;

  await evolution.sendTextMessage(instance, ownerPhone, confirmationMsg);
  return { success: true, message: confirmationMsg };
}
