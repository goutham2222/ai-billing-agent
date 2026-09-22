import { supabase } from '../../lib/supabase.js';
import { evolution } from '../../lib/evolution.js';
import { env } from '../../config/env.js';
import { ExtractedBill } from './schemas.js';
import { generateInvoicePdf, InvoiceItem } from '../invoicing/pdf-generator.js';
import { uploadInvoicePdfToStorage } from '../invoicing/storage.js';

export interface DraftAndPendingResult {
  customer: {
    id: string;
    name: string;
    phone: string;
  };
  bill: {
    id: string;
    bill_no?: number;
    customer_id: string;
    total_amount: number;
    payment_status: string;
    items: unknown;
    image_url?: string | null;
  };
  pendingAction: {
    whatsapp_message_id: string;
    status: string;
    owner_phone: string;
  };
}

export interface StoredBillData {
  bill_id: string;
  bill_no?: number;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  total_amount: number;
  items: unknown;
  payment_status: 'paid' | 'pending';
  image_url?: string | null;
  raw_message_id: string;
  raw_transcription?: string;
  expires_at: string;
}

/**
 * Normalizes phone numbers for WhatsApp delivery and consistent lookup.
 * Automatically adds the 91 country code to 10-digit Indian mobile numbers.
 */
export function normalizePhoneNumber(phone?: string): string {
  if (!phone) return '';
  const clean = phone.replace(/[^0-9]/g, '');
  if (clean.length === 10 && /^[6-9]/.test(clean)) {
    return `91${clean}`;
  }
  return clean;
}

/**
 * Safely sends a WhatsApp text message without throwing if the number is offline/invalid.
 */
async function safeSendTextMessage(phone: string, text: string): Promise<void> {
  try {
    if (phone) {
      await evolution.sendTextMessage(env.BILLING_INSTANCE_NAME, phone, text);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Evolution Notification] Message send bypassed or failed for ${phone}: ${msg}`);
  }
}

/**
 * Persists customer, creates a draft bill, and records a pending action
 * in Supabase for human-in-the-loop WhatsApp confirmation.
 */
export async function createDraftAndPendingAction(params: {
  extractedBill: ExtractedBill;
  mediaUrl?: string;
  rawMessageId: string;
  ownerPhone: string;
}): Promise<DraftAndPendingResult> {
  const { extractedBill, mediaUrl, rawMessageId, ownerPhone } = params;

  // 1. Customer Lookup / Upsert
  let customer: { id: string; name: string; phone: string } | null = null;
  const rawCustomerName = extractedBill.customer.name?.trim() || 'Walk-in Customer';
  const rawPhone = extractedBill.customer.phone?.replace(/[^0-9]/g, '');
  const normalizedPhone = normalizePhoneNumber(extractedBill.customer.phone);

  // 1a. Try lookup by phone if phone was provided
  if (normalizedPhone && normalizedPhone.length >= 7) {
    const filterQuery = rawPhone && rawPhone !== normalizedPhone
      ? `phone.eq.${normalizedPhone},phone.eq.${rawPhone}`
      : `phone.eq.${normalizedPhone}`;

    const { data: byPhone, error: phoneErr } = await supabase
      .from('customers')
      .select('id, name, phone')
      .or(filterQuery)
      .limit(1)
      .maybeSingle();

    if (!phoneErr && byPhone) {
      customer = byPhone;
    }
  }

  // 1b. If not found by phone, try lookup by name (case-insensitive)
  if (!customer && rawCustomerName.toLowerCase() !== 'walk-in customer') {
    const { data: byName, error: nameErr } = await supabase
      .from('customers')
      .select('id, name, phone')
      .ilike('name', rawCustomerName)
      .limit(1)
      .maybeSingle();

    if (!nameErr && byName) {
      customer = byName;
    }
  }

  // 1c. If still not found, insert new customer row
  if (!customer) {
    const preferredLang =
      extractedBill.detectedLanguage === 'te'
        ? 'Telugu'
        : extractedBill.detectedLanguage === 'hi'
        ? 'Hindi'
        : 'English';

    // Satisfy not-null and unique constraint on phone with normalized phone number
    const fallbackPhone = normalizedPhone && normalizedPhone.length >= 7
      ? normalizedPhone
      : `walkin-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

    const { data: newCustomer, error: insertCustErr } = await supabase
      .from('customers')
      .insert({
        name: rawCustomerName,
        phone: fallbackPhone,
        preferred_language: preferredLang,
      })
      .select('id, name, phone')
      .single();

    if (insertCustErr || !newCustomer) {
      throw new Error(`Failed to create customer: ${insertCustErr?.message || 'Unknown error'}`);
    }

    customer = newCustomer;
  }

  // 2. Insert draft bill into bills table
  const { data: newBill, error: billErr } = await supabase
    .from('bills')
    .insert({
      customer_id: customer.id,
      total_amount: extractedBill.totalAmount,
      items: extractedBill.items,
      image_url: mediaUrl || null,
      payment_status: extractedBill.paymentStatus,
    })
    .select('*')
    .single();

  if (billErr || !newBill) {
    throw new Error(`Failed to create draft bill: ${billErr?.message || 'Unknown error'}`);
  }

  // 3. Create Pending Action in pending_actions table
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const billData: StoredBillData = {
    bill_id: newBill.id,
    bill_no: newBill.bill_no,
    customer_id: customer.id,
    customer_name: customer.name,
    customer_phone: customer.phone,
    total_amount: Number(newBill.total_amount),
    items: extractedBill.items,
    payment_status: extractedBill.paymentStatus,
    image_url: mediaUrl || null,
    raw_message_id: rawMessageId,
    raw_transcription: extractedBill.rawTranscriptionOrOcr,
    expires_at: expiresAt,
  };

  const { data: pendingAction, error: actionErr } = await supabase
    .from('pending_actions')
    .insert({
      whatsapp_message_id: rawMessageId,
      bill_data: billData,
      owner_phone: ownerPhone,
      status: 'awaiting_confirmation',
    })
    .select('whatsapp_message_id, status, owner_phone')
    .single();

  if (actionErr || !pendingAction) {
    throw new Error(`Failed to insert pending action: ${actionErr?.message || 'Unknown error'}`);
  }

  return {
    customer,
    bill: newBill,
    pendingAction,
  };
}

/**
 * Formats a WhatsApp summary card and dispatches interactive list message
 * to the store owner via Evolution API, with automatic structured text fallback.
 */
export async function sendConfirmationList(params: {
  ownerPhone: string;
  bill: { id: string; bill_no?: number; total_amount: number };
  pendingActionId: string;
  extractedBill: ExtractedBill;
}): Promise<unknown> {
  const { ownerPhone, bill, pendingActionId: _pendingActionId, extractedBill } = params;
  const customerName = extractedBill.customer.name?.trim() || 'Customer';

  // Build items formatted list
  const itemsText = extractedBill.items.length > 0
    ? extractedBill.items
        .map((it) => {
          const qty = it.quantity ? `${it.quantity}${it.unit ? ` ${it.unit}` : ''}` : '';
          const linePrice = it.totalPrice ? ` - ₹${it.totalPrice}` : '';
          return `  • ${it.name}${qty ? ` (${qty})` : ''}${linePrice}`;
        })
        .join('\n')
    : '  • No itemized lines detected';

  const statusLabel =
    extractedBill.paymentStatus === 'paid'
      ? '✅ Paid (Settled)'
      : '⏳ Udhaar / Pending';

  const amountWarning =
    extractedBill.totalAmount === 0
      ? '\n⚠️ *Warning:* Total is ₹0 / missing - please price this bill.\n'
      : '';

  const billNumberText = bill.bill_no ? ` #${bill.bill_no}` : '';

  // 1. Title: "📝 Confirm Bill for {customerName}"
  const title = `📝 Confirm Bill for ${customerName}${billNumberText}`;

  // 2. Description: Formatted summary (items list, total amount, detected status)
  const description = [
    `🛒 *Items:*`,
    itemsText,
    amountWarning,
    `💰 *Total Amount:* ₹${extractedBill.totalAmount}`,
    `📌 *Detected Status:* ${statusLabel}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  // 3. Structured text card with direct reply instructions
  const cardText = `${title}\n\n${description}\n\n👉 *Reply with 1 (Paid), 2 (Udhaar), or 3 (Cancel)*`;
  await safeSendTextMessage(ownerPhone, cardText);

  // 4. Also dispatch a native interactive WhatsApp Poll for one-tap confirmation
  try {
    const pollTitle = `Confirm Bill${billNumberText}: ${customerName} (₹${extractedBill.totalAmount})`;
    await evolution.sendPoll(
      env.BILLING_INSTANCE_NAME,
      ownerPhone,
      pollTitle,
      ['1. Confirm Paid', '2. Confirm Udhaar', '3. Reject / Cancel'],
      1
    );
  } catch (pollErr: unknown) {
    const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
    console.debug(`[Evolution Poll] Native poll dispatch skipped or unconfirmed: ${msg}`);
  }

  return { success: true };
}

// Retain alias for backward compatibility
export const sendConfirmationButtons = sendConfirmationList;

/**
 * Asynchronously generates the PDF receipt, uploads it to Supabase Storage,
 * and sends it via WhatsApp document message to both store owner and customer.
 * Uses direct in-memory base64 encoding to bypass container-level HTTP fetch timeouts.
 */
async function generateAndSendInvoice(params: {
  billId: string;
  billNo: number | string;
  customerName: string;
  customerPhone?: string;
  totalAmount: number;
  items: unknown;
  paymentStatus: 'paid' | 'pending';
  ownerPhone: string;
}): Promise<void> {
  const {
    billId,
    billNo,
    customerName,
    customerPhone,
    totalAmount,
    items,
    paymentStatus,
    ownerPhone,
  } = params;

  try {
    const rawItems = Array.isArray(items) ? (items as InvoiceItem[]) : [];

    // 1. Generate PDF receipt buffer
    const pdfBuffer = await generateInvoicePdf({
      billNo: billNo || '1',
      date: new Date(),
      customer: {
        name: customerName,
        phone: customerPhone,
      },
      items: rawItems,
      totalAmount,
      paymentStatus,
    });

    // 2. Upload to Supabase Storage in 'invoices' bucket and save URL in bills table
    const { invoiceUrl } = await uploadInvoicePdfToStorage({
      billId,
      billNo: billNo || '1',
      pdfBuffer,
    });

    const statusBadge = paymentStatus === 'paid' ? 'PAID' : 'PENDING UDHAAR';
    const cleanBillNo = billNo ? `#${billNo}` : '';
    const pdfBase64 = pdfBuffer.toString('base64');

    // 3. Send PDF document to Store Owner using fast base64 payload
    if (ownerPhone) {
      try {
        await evolution.sendMedia(env.BILLING_INSTANCE_NAME, {
          number: ownerPhone,
          mediatype: 'document',
          mimetype: 'application/pdf',
          media: pdfBase64,
          fileName: `Invoice_${billNo || 'bill'}.pdf`,
          caption: `🧾 *Invoice ${cleanBillNo} - ${customerName}*\n💰 Total: Rs. ${totalAmount}\n📌 Status: ${statusBadge}`,
        });
      } catch (ownerSendErr: unknown) {
        // Fallback to public storage URL if base64 fails
        try {
          await evolution.sendMedia(env.BILLING_INSTANCE_NAME, {
            number: ownerPhone,
            mediatype: 'document',
            mimetype: 'application/pdf',
            media: invoiceUrl,
            fileName: `Invoice_${billNo || 'bill'}.pdf`,
            caption: `🧾 *Invoice ${cleanBillNo} - ${customerName}*\n💰 Total: Rs. ${totalAmount}\n📌 Status: ${statusBadge}`,
          });
        } catch (fallbackErr: unknown) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          console.warn(`[Invoice Dispatch] Failed to send PDF to owner: ${msg}`);
        }
      }
    }

    // 4. Send PDF copy to Customer (with normalized country-coded phone)
    const cleanCustomerPhone = normalizePhoneNumber(customerPhone);
    const hasValidCustomerPhone =
      cleanCustomerPhone &&
      cleanCustomerPhone.length >= 10 &&
      !customerPhone?.startsWith('walkin-');

    if (hasValidCustomerPhone) {
      const customerGreeting =
        paymentStatus === 'paid'
          ? `🧾 *Tax Invoice / Receipt ${cleanBillNo}*\nDear ${customerName}, here is your receipt for Rs. ${totalAmount}. Payment received with thanks!`
          : `🧾 *Invoice ${cleanBillNo}*\nDear ${customerName}, here is your invoice for Rs. ${totalAmount} recorded as Pending Udhaar. Thank you!`;

      try {
        await evolution.sendMedia(env.BILLING_INSTANCE_NAME, {
          number: cleanCustomerPhone,
          mediatype: 'document',
          mimetype: 'application/pdf',
          media: pdfBase64,
          fileName: `Invoice_${billNo || 'bill'}.pdf`,
          caption: customerGreeting,
        });
      } catch (custSendErr: unknown) {
        // Fallback to public storage URL
        try {
          await evolution.sendMedia(env.BILLING_INSTANCE_NAME, {
            number: cleanCustomerPhone,
            mediatype: 'document',
            mimetype: 'application/pdf',
            media: invoiceUrl,
            fileName: `Invoice_${billNo || 'bill'}.pdf`,
            caption: customerGreeting,
          });
        } catch (fallbackCustErr: unknown) {
          const msg = fallbackCustErr instanceof Error ? fallbackCustErr.message : String(fallbackCustErr);
          console.warn(`[Invoice Dispatch] Failed to send PDF to customer (${customerPhone}): ${msg}`);
        }
      }
    }
  } catch (err: unknown) {
    console.error(`[Invoice Hook] PDF generation or dispatch failed for bill ${billId}:`, err);
  }
}

/**
 * Resolves an owner's button click reply and updates the pending action
 * and bill status in the database.
 */
export async function handleButtonConfirmation(params: {
  selectedButtonId: string;
  senderPhone: string;
}): Promise<{ success: boolean; message: string }> {
  const { selectedButtonId, senderPhone } = params;

  // Match pattern: action_(paid|pending|reject)_(actionId)
  const match = selectedButtonId.match(/^action_(paid|pending|reject)_(.+)$/);
  if (!match) {
    return { success: false, message: 'Invalid button action ID format' };
  }

  const actionChoice = match[1] as 'paid' | 'pending' | 'reject';
  const pendingActionId = match[2];

  if (!pendingActionId) {
    return { success: false, message: 'Missing pending action ID' };
  }

  // 1. Query pending action by whatsapp_message_id
  const { data: action, error: fetchErr } = await supabase
    .from('pending_actions')
    .select('*')
    .eq('whatsapp_message_id', pendingActionId)
    .maybeSingle();

  if (fetchErr || !action) {
    const alertMsg = '⚠️ Bill action record not found. It may have expired or already been processed.';
    await safeSendTextMessage(senderPhone, alertMsg);
    return { success: false, message: alertMsg };
  }

  if (action.status === 'completed' || action.status === 'cancelled') {
    const alertMsg = `ℹ️ This bill has already been marked as *${action.status.toUpperCase()}*.`;
    await safeSendTextMessage(senderPhone, alertMsg);
    return { success: false, message: alertMsg };
  }

  const billData = (action.bill_data as StoredBillData) || {};
  const billId = billData.bill_id;
  const billNo = billData.bill_no ? `#${billData.bill_no}` : '';
  const customerName = billData.customer_name || 'Customer';
  const totalAmount = billData.total_amount ?? 0;

  // 2. Perform state transitions
  if (actionChoice === 'paid') {
    // Mark bill as paid
    if (billId) {
      await supabase
        .from('bills')
        .update({ payment_status: 'paid' })
        .eq('id', billId);
    }

    await supabase
      .from('pending_actions')
      .update({ status: 'completed' })
      .eq('whatsapp_message_id', pendingActionId);

    const confirmationText = `✅ *Bill ${billNo} Confirmed: PAID*\n👤 Customer: *${customerName}*\n💰 Amount: *₹${totalAmount}*\nPayment recorded as cleared.`;
    await safeSendTextMessage(senderPhone, confirmationText);

    // Stage 5 Hook: Trigger PDF generation & WhatsApp dispatch
    if (billId) {
      setImmediate(() => {
        generateAndSendInvoice({
          billId,
          billNo: billData.bill_no || billNo.replace('#', '') || '1',
          customerName,
          customerPhone: billData.customer_phone,
          totalAmount,
          items: billData.items,
          paymentStatus: 'paid',
          ownerPhone: senderPhone,
        }).catch((err) => console.error('[Invoice Background Hook Error]:', err));
      });
    }

    return { success: true, message: confirmationText };
  }

  if (actionChoice === 'pending') {
    // Mark bill as pending (Udhaar)
    if (billId) {
      await supabase
        .from('bills')
        .update({ payment_status: 'pending' })
        .eq('id', billId);
    }

    await supabase
      .from('pending_actions')
      .update({ status: 'completed' })
      .eq('whatsapp_message_id', pendingActionId);

    const confirmationText = `⏳ *Bill ${billNo} Confirmed: UDHAAR (Pending)*\n👤 Customer: *${customerName}*\n💰 Amount: *₹${totalAmount}*\nRecorded into customer ledger as pending debt.`;
    await safeSendTextMessage(senderPhone, confirmationText);

    // Stage 5 Hook: Trigger PDF generation & WhatsApp dispatch
    if (billId) {
      setImmediate(() => {
        generateAndSendInvoice({
          billId,
          billNo: billData.bill_no || billNo.replace('#', '') || '1',
          customerName,
          customerPhone: billData.customer_phone,
          totalAmount,
          items: billData.items,
          paymentStatus: 'pending',
          ownerPhone: senderPhone,
        }).catch((err) => console.error('[Invoice Background Hook Error]:', err));
      });
    }

    return { success: true, message: confirmationText };
  }

  if (actionChoice === 'reject') {
    // Reject / Cancel draft bill
    if (billId) {
      await supabase
        .from('bills')
        .update({ payment_status: 'cancelled' })
        .eq('id', billId);
    }

    await supabase
      .from('pending_actions')
      .update({ status: 'cancelled' })
      .eq('whatsapp_message_id', pendingActionId);

    const confirmationText = `❌ *Bill ${billNo} CANCELLED*\nThe draft bill for ${customerName} (₹${totalAmount}) has been cancelled.`;
    await safeSendTextMessage(senderPhone, confirmationText);
    return { success: true, message: confirmationText };
  }

  return { success: false, message: 'Unrecognized action choice' };
}

