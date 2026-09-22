import { z } from 'zod';

export const BillItemSchema = z.object({
  name: z.string().min(1, { message: 'Item name is required' }),
  quantity: z.coerce.number().positive().default(1),
  unit: z.string().optional(),
  unitPrice: z.coerce.number().nonnegative().optional(),
  totalPrice: z.coerce.number().nonnegative(),
});

export const CustomerInfoSchema = z.object({
  name: z.string().min(1).default('Walk-in Customer'),
  phone: z.string().optional(),
});

export const ExtractedBillSchema = z.object({
  customer: CustomerInfoSchema,
  items: z.array(BillItemSchema).default([]),
  totalAmount: z.coerce.number().nonnegative(),
  paymentStatus: z.enum(['paid', 'pending'], {
    message: "paymentStatus must be either 'paid' or 'pending'",
  }),
  detectedLanguage: z.enum(['en', 'hi', 'te', 'mixed'], {
    message: "detectedLanguage must be 'en', 'hi', 'te', or 'mixed'",
  }),
  rawTranscriptionOrOcr: z.string().default(''),
  confidenceNotes: z.string().optional(),
});

export type BillItem = z.infer<typeof BillItemSchema>;
export type CustomerInfo = z.infer<typeof CustomerInfoSchema>;
export type ExtractedBill = z.infer<typeof ExtractedBillSchema>;
