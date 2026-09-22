import PDFDocument from 'pdfkit';

export interface InvoiceItem {
  name: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  totalPrice: number;
}

export interface InvoiceData {
  billNo: number | string;
  date: Date | string;
  storeName?: string;
  storeContact?: string;
  customer: {
    name: string;
    phone?: string;
  };
  items: InvoiceItem[];
  totalAmount: number;
  paymentStatus: 'paid' | 'pending';
}

/**
 * Generates a clean, branded PDF invoice receipt and returns it as a Buffer.
 */
export async function generateInvoicePdf(data: InvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        info: {
          Title: `Invoice #${data.billNo}`,
          Author: data.storeName || 'Retail Store',
        },
      });

      const buffers: Buffer[] = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', (err) => reject(err));

      const storeName = data.storeName || 'Kirana & General Store';
      const storeContact = data.storeContact || 'WhatsApp Automated Billing';
      const formattedDate =
        data.date instanceof Date
          ? data.date.toLocaleDateString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })
          : new Date(data.date).toLocaleDateString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            });

      const isPaid = data.paymentStatus === 'paid';
      const statusText = isPaid ? 'PAID / SETTLED' : 'PENDING UDHAAR';
      const statusColor = isPaid ? '#059669' : '#d97706';
      const statusBg = isPaid ? '#ecfdf5' : '#fffbeb';

      // 1. Header (Store Title & Document Info)
      doc.rect(40, 40, 515, 65).fill('#f8fafc');

      doc
        .fillColor('#0f172a')
        .fontSize(20)
        .font('Helvetica-Bold')
        .text(storeName, 55, 52);

      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#64748b')
        .text(storeContact, 55, 78);

      doc
        .fillColor('#1e293b')
        .fontSize(16)
        .font('Helvetica-Bold')
        .text('TAX INVOICE', 380, 52, { align: 'right', width: 160 });

      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#64748b')
        .text(`Bill No: #${data.billNo}`, 380, 72, { align: 'right', width: 160 })
        .text(`Date: ${formattedDate}`, 380, 86, { align: 'right', width: 160 });

      doc.y = 120;

      // 2. Customer Details & Payment Status Badge
      doc
        .fontSize(11)
        .font('Helvetica-Bold')
        .fillColor('#334155')
        .text('BILLED TO:', 55, 125);

      const customerPhone =
        data.customer.phone && !data.customer.phone.startsWith('walkin-')
          ? data.customer.phone
          : 'Walk-in Customer';

      doc
        .fontSize(12)
        .font('Helvetica-Bold')
        .fillColor('#0f172a')
        .text(data.customer.name, 55, 140);

      doc
        .fontSize(10)
        .font('Helvetica')
        .fillColor('#64748b')
        .text(`Phone: ${customerPhone}`, 55, 156);

      // Status Badge Box
      const badgeX = 390;
      const badgeY = 125;
      const badgeW = 150;
      const badgeH = 34;

      doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 4).fill(statusBg);
      doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 4).strokeColor(statusColor).lineWidth(1).stroke();

      doc
        .fillColor(statusColor)
        .fontSize(11)
        .font('Helvetica-Bold')
        .text(statusText, badgeX, badgeY + 11, { align: 'center', width: badgeW });

      doc.y = 185;

      // 3. Table Header
      const tableTop = 195;
      const colX = { item: 55, qty: 320, unitPrice: 390, total: 470 };

      doc.rect(40, tableTop, 515, 24).fill('#f1f5f9');
      doc
        .fillColor('#334155')
        .fontSize(10)
        .font('Helvetica-Bold')
        .text('ITEM DESCRIPTION', colX.item, tableTop + 7)
        .text('QTY', colX.qty, tableTop + 7)
        .text('PRICE', colX.unitPrice, tableTop + 7)
        .text('TOTAL', colX.total, tableTop + 7);

      // 4. Table Rows
      let currentY = tableTop + 30;
      const items = data.items.length > 0
        ? data.items
        : [{ name: 'Store Items', totalPrice: data.totalAmount }];

      for (const item of items) {
        // Page break safety check
        if (currentY > 700) {
          doc.addPage();
          currentY = 50;
        }

        const qtyText = item.quantity
          ? `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`
          : '1';
        const priceText = item.unitPrice ? `Rs. ${item.unitPrice.toFixed(2)}` : '-';
        const lineTotalText = `Rs. ${(item.totalPrice || 0).toFixed(2)}`;

        doc
          .fillColor('#1e293b')
          .fontSize(10)
          .font('Helvetica')
          .text(item.name, colX.item, currentY, { width: 250, ellipsis: true })
          .text(qtyText, colX.qty, currentY)
          .text(priceText, colX.unitPrice, currentY)
          .text(lineTotalText, colX.total, currentY);

        currentY += 22;

        // Thin separator
        doc
          .strokeColor('#f1f5f9')
          .lineWidth(0.5)
          .moveTo(40, currentY - 5)
          .lineTo(555, currentY - 5)
          .stroke();
      }

      currentY += 10;

      // 5. Total Section
      doc.rect(340, currentY, 215, 55).fill('#f8fafc');

      doc
        .fillColor('#64748b')
        .fontSize(10)
        .font('Helvetica')
        .text('Subtotal:', 355, currentY + 12)
        .text(`Rs. ${data.totalAmount.toFixed(2)}`, 450, currentY + 12, { align: 'right', width: 90 });

      doc
        .fillColor('#0f172a')
        .fontSize(12)
        .font('Helvetica-Bold')
        .text('Grand Total:', 355, currentY + 32)
        .text(`Rs. ${data.totalAmount.toFixed(2)}`, 450, currentY + 32, { align: 'right', width: 90 });

      // 6. Footer Notes
      const footerY = Math.max(currentY + 80, 680);
      doc
        .strokeColor('#e2e8f0')
        .lineWidth(1)
        .moveTo(40, footerY)
        .lineTo(555, footerY)
        .stroke();

      doc
        .fillColor('#64748b')
        .fontSize(9)
        .font('Helvetica')
        .text('Thank you for shopping with us! For any inquiries, please contact the store.', 40, footerY + 10, {
          align: 'center',
          width: 515,
        })
        .text('Generated automatically by WhatsApp AI Billing CRM', 40, footerY + 24, {
          align: 'center',
          width: 515,
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
