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
    tier: 'existing' | 'new' | 'walkin';
    outstandingDebt: number;
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
  customer_tier?: 'existing' | 'new' | 'walkin';
  outstanding_debt?: number;
  total_amount: number;
  items: unknown;
  payment_status: 'paid' | 'pending';
  image_url?: string | null;
  raw_message_id: string;
  raw_transcription?: string;
  expires_at: string;
}

export interface CustomerCardInfo {
  name: string;
  phone?: string;
  tier?: 'existing' | 'new' | 'walkin';
  outstandingDebt?: number;
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

  // 1. Determine Customer Tier and Identifiers
  const rawCustomerName = extractedBill.customer.name?.trim() || '';
  const isAnonymousName =
    !rawCustomerName ||
    rawCustomerName.toLowerCase() === 'walk-in customer' ||
    rawCustomerName.toLowerCase() === 'walk in customer' ||
    rawCustomerName.toLowerCase() === 'walk-in' ||
    rawCustomerName.toLowerCase() === 'walkin' ||
    rawCustomerName.toLowerCase() === 'anonymous' ||
    rawCustomerName.toLowerCase() === 'customer';

  const rawPhone = extractedBill.customer.phone?.replace(/[^0-9]/g, '') || '';
  const normalizedPhone = normalizePhoneNumber(extractedBill.customer.phone);
  const hasValidPhone = normalizedPhone.length >= 7 || rawPhone.length >= 7;
  const hasNamedIdentifier = !isAnonymousName;
  const hasIdentifier = hasNamedIdentifier || hasValidPhone;

  let customer: {
    id: string;
    name: string;
    phone: string;
    tier: 'existing' | 'new' | 'walkin';
    outstandingDebt: number;
  };

  if (!hasIdentifier) {
    // Tier 3: Walk-in Customer (Anonymous - zero identifiers provided)
    let walkinCust: { id: string; name: string; phone: string } | null = null;
    const { data: existingWalkin } = await supabase
      .from('customers')
      .select('id, name, phone')
      .eq('name', 'Walk-in Customer')
      .limit(1)
      .maybeSingle();

    if (existingWalkin) {
      walkinCust = existingWalkin;
    } else {
      const fallbackPhone = `walkin-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
      const { data: newWalkin, error: insertWalkinErr } = await supabase
        .from('customers')
        .insert({
          name: 'Walk-in Customer',
          phone: fallbackPhone,
          preferred_language: 'en',
        })
        .select('id, name, phone')
        .single();

      if (insertWalkinErr || !newWalkin) {
        throw new Error(`Failed to create walk-in customer: ${insertWalkinErr?.message || 'Unknown error'}`);
      }
      walkinCust = newWalkin;
    }

    customer = {
      id: walkinCust.id,
      name: 'Walk-in Customer',
      phone: walkinCust.phone,
      tier: 'walkin',
      outstandingDebt: 0,
    };
  } else {
    // Has identifier: Search for existing customer (Tier 1)
    let existingCust: { id: string; name: string; phone: string } | null = null;

    // 1a. Try lookup by phone if phone was provided
    if (hasValidPhone) {
      const last10 = normalizedPhone.slice(-10);
      let phoneQuery = supabase.from('customers').select('id, name, phone');

      if (last10.length === 10) {
        phoneQuery = phoneQuery.or(`phone.eq.${normalizedPhone},phone.ilike.%${last10}`);
      } else {
        phoneQuery = phoneQuery.eq('phone', normalizedPhone);
      }

      const { data: byPhone, error: phoneErr } = await phoneQuery.limit(1).maybeSingle();
      if (!phoneErr && byPhone) {
        existingCust = byPhone;
      }
    }

    // 1b. Try lookup by name (case-insensitive ILIKE) if not found by phone and name provided
    if (!existingCust && hasNamedIdentifier) {
      const { data: byName, error: nameErr } = await supabase
        .from('customers')
        .select('id, name, phone')
        .ilike('name', rawCustomerName)
        .limit(1)
        .maybeSingle();

      if (!nameErr && byName) {
        existingCust = byName;
      }
    }

    if (existingCust) {
      // Tier 1: Existing Customer
      // Fetch current total_debt from unpaid bills (payment_status = 'pending')
      const { data: unpaidBills } = await supabase
        .from('bills')
        .select('total_amount')
        .eq('customer_id', existingCust.id)
        .eq('payment_status', 'pending');

      const totalDebt = (unpaidBills || []).reduce(
        (sum, b) => sum + (Number(b.total_amount) || 0),
        0
      );

      customer = {
        id: existingCust.id,
        name: existingCust.name,
        phone: existingCust.phone,
        tier: 'existing',
        outstandingDebt: totalDebt,
      };
    } else {
      // Tier 2: New Customer Onboarded (Identifier provided but not in DB)
      const preferredLang =
        extractedBill.detectedLanguage === 'te'
          ? 'Telugu'
          : extractedBill.detectedLanguage === 'hi'
          ? 'Hindi'
          : 'English';

      const customerName = hasNamedIdentifier
        ? rawCustomerName
        : `Customer ${rawPhone.slice(-4) || 'New'}`;

      const customerPhone = normalizedPhone && normalizedPhone.length >= 7
        ? normalizedPhone
        : `newcust-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

      const { data: newCustomer, error: insertCustErr } = await supabase
        .from('customers')
        .insert({
          name: customerName,
          phone: customerPhone,
          preferred_language: preferredLang,
        })
        .select('id, name, phone')
        .single();

      if (insertCustErr || !newCustomer) {
        throw new Error(`Failed to create new customer: ${insertCustErr?.message || 'Unknown error'}`);
      }

      customer = {
        id: newCustomer.id,
        name: newCustomer.name,
        phone: newCustomer.phone,
        tier: 'new',
        outstandingDebt: 0,
      };
    }
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

  // 3. Stale Action Guardrail: Enforce strictly <= 1 active pending action per owner
  // Automatically mark any older unconfirmed awaiting_confirmation actions as 'superseded'
  const last10Owner = ownerPhone ? ownerPhone.slice(-10) : '';
  if (last10Owner.length === 10) {
    await supabase
      .from('pending_actions')
      .update({ status: 'superseded' })
      .eq('status', 'awaiting_confirmation')
      .ilike('owner_phone', `%${last10Owner}`);
  } else if (ownerPhone) {
    await supabase
      .from('pending_actions')
      .update({ status: 'superseded' })
      .eq('status', 'awaiting_confirmation')
      .eq('owner_phone', ownerPhone);
  }

  // 4. Create Pending Action in pending_actions table
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const billData: StoredBillData = {
    bill_id: newBill.id,
    bill_no: newBill.bill_no,
    customer_id: customer.id,
    customer_name: customer.name,
    customer_phone: customer.phone,
    customer_tier: customer.tier,
    outstanding_debt: customer.outstandingDebt,
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
  customerInfo?: CustomerCardInfo;
}): Promise<unknown> {
  const { ownerPhone, bill, pendingActionId: _pendingActionId, extractedBill, customerInfo } = params;
  const customerName = customerInfo?.name || extractedBill.customer.name?.trim() || 'Walk-in Customer';
  const tier = customerInfo?.tier || (extractedBill.customer.name && extractedBill.customer.name.toLowerCase() !== 'walk-in customer' ? 'existing' : 'walkin');
  const outstandingDebt = customerInfo?.outstandingDebt ?? 0;

  // Format customer display line matching 3-tier rules
  let customerLine = `👤 *Customer:* ${customerName}`;
  if (tier === 'existing') {
    customerLine = `👤 *Customer:* ${customerName} (Existing — Outstanding Udhaar: Rs. ${outstandingDebt})`;
  } else if (tier === 'new') {
    customerLine = `👤 *Customer:* ${customerName} [New Customer Onboarded]`;
  } else if (tier === 'walkin') {
    customerLine = `👤 *Customer:* Walk-in Customer (Anonymous)`;
  }

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

  // 1. Title
  const title = `📝 Confirm Bill for ${customerName}${billNumberText}`;

  // 2. Description: Formatted summary card with 3-tier customer info
  const description = [
    customerLine,
    `🛒 *Items:*`,
    itemsText,
    amountWarning,
    `💰 *Total Amount:* ₹${extractedBill.totalAmount}`,
    `📌 *Detected Status:* ${statusLabel}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  // 3. Send clean, well-formatted WhatsApp text summary card with explicit reply instructions
  const cardText = [
    `*${title}*`,
    '',
    description,
    '',
    '👉 *Reply with:*',
    '• *1* (or *paid* / *settled* / *jama*) ➔ Confirm Paid',
    '• *2* (or *udhaar* / *pending* / *baki*) ➔ Confirm Udhaar',
    '• *3* (or *cancel* / *reject* / *discard*) ➔ Discard Draft',
  ].join('\n');

  await safeSendTextMessage(ownerPhone, cardText);
  return { success: true };
}

// Aliases for backward compatibility and clean semantics
export const sendConfirmationPrompt = sendConfirmationList;
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

  // Zero-amount guardrail: Never generate or dispatch PDF invoices if total_amount <= 0
  if (totalAmount <= 0) {
    console.info(`[Invoice Engine] Skipping invoice generation: totalAmount is ${totalAmount}`);
    return;
  }

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

    // 3. Separate Owner vs Customer Dispatch Determination
    const cleanCustomerPhone = normalizePhoneNumber(customerPhone);
    const cleanOwnerPhone = normalizePhoneNumber(ownerPhone || env.STORE_OWNER_PHONE);

    const isCustomerPhoneMissingOrWalkin =
      !cleanCustomerPhone ||
      cleanCustomerPhone.length < 10 ||
      customerPhone?.startsWith('walkin-') ||
      customerPhone?.startsWith('newcust-');

    const isSelfTesting =
      !isCustomerPhoneMissingOrWalkin &&
      Boolean(
        cleanCustomerPhone === cleanOwnerPhone ||
        (cleanOwnerPhone.length >= 10 && cleanCustomerPhone.endsWith(cleanOwnerPhone.slice(-10))) ||
        (cleanCustomerPhone.length >= 10 && cleanOwnerPhone.endsWith(cleanCustomerPhone.slice(-10)))
      );

    const hasSeparateCustomerPhone = !isCustomerPhoneMissingOrWalkin && !isSelfTesting;

    // Helper for reliable WhatsApp media dispatch with base64 and URL fallback
    const sendPdfDocument = async (targetPhone: string, captionText: string) => {
      try {
        await evolution.sendMedia(env.BILLING_INSTANCE_NAME, {
          number: targetPhone,
          mediatype: 'document',
          mimetype: 'application/pdf',
          media: pdfBase64,
          fileName: `Invoice_${billNo || 'bill'}.pdf`,
          caption: captionText,
        });
      } catch (sendErr: unknown) {
        try {
          await evolution.sendMedia(env.BILLING_INSTANCE_NAME, {
            number: targetPhone,
            mediatype: 'document',
            mimetype: 'application/pdf',
            media: invoiceUrl,
            fileName: `Invoice_${billNo || 'bill'}.pdf`,
            caption: captionText,
          });
        } catch (fallbackErr: unknown) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          console.warn(`[Invoice Dispatch] Failed to send PDF to ${targetPhone}: ${msg}`);
        }
      }
    };

    if (hasSeparateCustomerPhone) {
      // Dispatch PDF ONLY to Customer with personalized greeting
      const customerGreeting =
        paymentStatus === 'paid'
          ? `🧾 *Tax Invoice / Receipt ${cleanBillNo}*\nDear ${customerName}, here is your receipt for Rs. ${totalAmount}. Payment received with thanks!`
          : `🧾 *Invoice ${cleanBillNo}*\nDear ${customerName}, here is your invoice for Rs. ${totalAmount} recorded as Pending Udhaar. Thank you!`;

      await sendPdfDocument(cleanCustomerPhone, customerGreeting);
    } else {
      // Self-testing scenario or customer phone missing: Send PDF to Store Owner so generated artifact is visible
      const targetOwner = cleanOwnerPhone || ownerPhone;
      if (targetOwner) {
        const ownerCaption = `🧾 *Invoice ${cleanBillNo} - ${customerName}*\n💰 Total: Rs. ${totalAmount}\n📌 Status: ${statusBadge}`;
        await sendPdfDocument(targetOwner, ownerCaption);
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
    const alertMsg = '⚠️ This bill has already been confirmed and finalized.';
    await safeSendTextMessage(senderPhone, alertMsg);
    return { success: false, message: alertMsg };
  }

  if (action.status === 'superseded') {
    const alertMsg = '⚠️ This bill draft has been superseded by a newer bill.';
    await safeSendTextMessage(senderPhone, alertMsg);
    return { success: false, message: alertMsg };
  }

  const billData = (action.bill_data as StoredBillData) || {};
  const billId = billData.bill_id;
  const billNo = billData.bill_no ? `#${billData.bill_no}` : '';
  const customerName = billData.customer_name || 'Customer';
  const totalAmount = billData.total_amount ?? 0;

  // Walk-in Udhaar Block Guardrail: Disallow confirming Walk-in drafts as Udhaar
  if (actionChoice === 'pending') {
    const isWalkin =
      billData.customer_tier === 'walkin' ||
      customerName.toLowerCase() === 'walk-in customer' ||
      customerName.toLowerCase() === 'walk in customer' ||
      customerName.toLowerCase() === 'walk-in' ||
      customerName.toLowerCase() === 'walkin' ||
      customerName.toLowerCase() === 'anonymous' ||
      billData.customer_phone?.startsWith('walkin-');

    if (isWalkin) {
      const blockMsg =
        '⚠️ Cannot assign Udhaar to an anonymous Walk-in Customer. Please provide customer name or phone.';
      await safeSendTextMessage(senderPhone, blockMsg);
      return { success: false, message: blockMsg };
    }
  }

  // Determine delivery recipient context
  const cleanCustomerPhone = normalizePhoneNumber(billData.customer_phone);
  const cleanOwnerPhone = normalizePhoneNumber(senderPhone || env.STORE_OWNER_PHONE);

  const isCustomerPhoneMissingOrWalkin =
    !cleanCustomerPhone ||
    cleanCustomerPhone.length < 10 ||
    billData.customer_phone?.startsWith('walkin-') ||
    billData.customer_phone?.startsWith('newcust-');

  const isSelfTesting =
    !isCustomerPhoneMissingOrWalkin &&
    Boolean(
      cleanCustomerPhone === cleanOwnerPhone ||
      (cleanOwnerPhone.length >= 10 && cleanCustomerPhone.endsWith(cleanOwnerPhone.slice(-10))) ||
      (cleanCustomerPhone.length >= 10 && cleanOwnerPhone.endsWith(cleanCustomerPhone.slice(-10)))
    );

  const willDeliverToCustomer = !isCustomerPhoneMissingOrWalkin && !isSelfTesting && totalAmount > 0;
  const willDeliverToOwner = (isSelfTesting || isCustomerPhoneMissingOrWalkin) && totalAmount > 0;

  // 2. Perform state transitions
  if (actionChoice === 'paid') {
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

    let confirmationText = `✅ Bill ${billNo} for ${customerName} confirmed as PAID (Rs. ${totalAmount}).`;
    if (totalAmount <= 0) {
      confirmationText = `✅ Bill ${billNo} for ${customerName} confirmed as PAID (Rs. ${totalAmount}). (No invoice generated for ₹0 amount).`;
    } else if (willDeliverToCustomer) {
      confirmationText = `✅ Bill ${billNo} for ${customerName} confirmed as PAID (Rs. ${totalAmount}). PDF invoice delivered to customer.`;
    } else if (willDeliverToOwner) {
      confirmationText = `✅ Bill ${billNo} for ${customerName} confirmed as PAID (Rs. ${totalAmount}). PDF invoice generated below.`;
    }

    await safeSendTextMessage(senderPhone, confirmationText);

    // Stage 5 Hook: Trigger PDF generation & WhatsApp dispatch if totalAmount > 0
    if (billId && totalAmount > 0) {
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

    let confirmationText = `⏳ Bill ${billNo} for ${customerName} confirmed as UDHAAR (Rs. ${totalAmount}).`;
    if (totalAmount <= 0) {
      confirmationText = `⏳ Bill ${billNo} for ${customerName} confirmed as UDHAAR (Rs. ${totalAmount}). (No invoice generated for ₹0 amount).`;
    } else if (willDeliverToCustomer) {
      confirmationText = `⏳ Bill ${billNo} for ${customerName} confirmed as UDHAAR (Rs. ${totalAmount}). PDF invoice delivered to customer.`;
    } else if (willDeliverToOwner) {
      confirmationText = `⏳ Bill ${billNo} for ${customerName} confirmed as UDHAAR (Rs. ${totalAmount}). PDF invoice generated below.`;
    }

    await safeSendTextMessage(senderPhone, confirmationText);

    // Stage 5 Hook: Trigger PDF generation & WhatsApp dispatch if totalAmount > 0
    if (billId && totalAmount > 0) {
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

