import { supabase } from '../../lib/supabase.js';

export interface UploadInvoiceResult {
  storagePath: string;
  invoiceUrl: string;
}

/**
 * Uploads a generated PDF invoice buffer to the Supabase Storage 'invoices' bucket
 * and persists the public invoice URL to the bills table.
 */
export async function uploadInvoicePdfToStorage(params: {
  billId: string;
  billNo: number | string;
  pdfBuffer: Buffer;
}): Promise<UploadInvoiceResult> {
  const { billId, billNo, pdfBuffer } = params;
  const fileName = `${billNo}_${Date.now()}.pdf`;
  const storagePath = `bills/${fileName}`;

  // 1. Upload PDF binary to Supabase Storage in 'invoices' bucket
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('invoices')
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError || !uploadData) {
    throw new Error(`Failed to upload invoice PDF to Supabase Storage: ${uploadError?.message}`);
  }

  // 2. Retrieve public URL for the uploaded invoice
  const { data: urlData } = supabase.storage
    .from('invoices')
    .getPublicUrl(storagePath);

  const invoiceUrl = urlData.publicUrl;

  // 3. Update the bills row with the permanent invoice URL in pdf_url column
  const { error: dbError } = await supabase
    .from('bills')
    .update({ pdf_url: invoiceUrl })
    .eq('id', billId);

  if (dbError) {
    console.warn(
      `[Invoice Storage] Warning: Could not update pdf_url in bills table for bill ${billId}: ${dbError.message}`
    );
  }

  return {
    storagePath,
    invoiceUrl,
  };
}
