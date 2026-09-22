/**
 * DDL representation and business intelligence context for PostgreSQL schema.
 * Passed to Gemini Text-to-SQL prompt for accurate SQL generation.
 */

export const POSTGRES_SCHEMA_DDL = `
-- 1. Customers Table
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    preferred_language TEXT DEFAULT 'en',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Bills Table
CREATE TABLE bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no SERIAL, -- Auto-incrementing integer bill identifier (e.g. 101, 102)
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    total_amount NUMERIC(12, 2) NOT NULL,
    items JSONB DEFAULT '[]', -- JSON array of line items: [{"name": "Rice", "quantity": 2, "unit": "kg", "unitPrice": 60, "totalPrice": 120}]
    image_url TEXT,
    pdf_url TEXT,
    payment_status TEXT CHECK (payment_status IN ('paid', 'pending', 'cancelled')) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Pending Actions Table (State tracking for bill confirmations)
CREATE TABLE pending_actions (
    whatsapp_message_id TEXT PRIMARY KEY,
    bill_data JSONB, -- Draft bill snapshot
    owner_phone TEXT,
    status TEXT DEFAULT 'awaiting_confirmation', -- 'awaiting_confirmation', 'completed', 'cancelled'
    created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

export const BUSINESS_RULES_CONTEXT = `
### Store Analytics Business Rules & Guidelines:
1. REVENUE & SALES CALCULATIONS:
   - Always exclude cancelled bills: WHERE bills.payment_status != 'cancelled'.
   - Total Gross Revenue = SUM(bills.total_amount) WHERE bills.payment_status != 'cancelled'.
   - Cash / Settled Sales = SUM(bills.total_amount) WHERE bills.payment_status = 'paid'.
   - Udhaar / Pending Debt = SUM(bills.total_amount) WHERE bills.payment_status = 'pending'.
   - "Udhaar", "Baki", "Due", "Pending", "Ivvali" all mean: bills.payment_status = 'pending'.
   - "Cash", "Paid", "Diya", "Settled", "Ichadu" all mean: bills.payment_status = 'paid'.

2. CUSTOMER AGGREGATIONS & DEBT:
   - When asked for customer debt or who owes money:
     SELECT c.id, c.name, c.phone, COALESCE(SUM(b.total_amount), 0) AS total_debt, COUNT(b.id) AS pending_bills_count
     FROM customers c
     JOIN bills b ON c.id = b.customer_id
     WHERE b.payment_status = 'pending'
     GROUP BY c.id, c.name, c.phone
     ORDER BY total_debt DESC;
   - If asked for a specific customer by name (e.g. "Ramesh" or "రమేష్"):
     Use ILIKE '%name%' to find case-insensitive matches: c.name ILIKE '%Ramesh%'.

3. TIMEZONE & DATE COMPARISONS (IST - Asia/Kolkata):
   - The store operates in Indian Standard Time (Asia/Kolkata / UTC+5:30).
   - "Today":
     bills.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
   - "Yesterday":
     bills.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE - INTERVAL '1 day'
     AND bills.created_at < (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::DATE
   - "This Week":
     bills.created_at >= DATE_TRUNC('week', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
   - "This Month":
     bills.created_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')
   - "Last 7 Days":
     bills.created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
   - "Last 30 Days":
     bills.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'

4. ITEMS SOLD / INVENTORY QUERIES:
   - To query items inside the JSONB column:
     SELECT item->>'name' AS item_name, SUM((item->>'quantity')::numeric) AS total_quantity, SUM((item->>'totalPrice')::numeric) AS total_sales
     FROM bills b, jsonb_array_elements(b.items) AS item
     WHERE b.payment_status != 'cancelled'
     GROUP BY item->>'name'
     ORDER BY total_quantity DESC;

5. SAFETY & CONSTRAINTS:
   - Queries MUST be single PostgreSQL SELECT statements.
   - Do NOT use INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, GRANT, or multi-statement semicolons.
   - Always limit results to at most 50 rows if unconstrained.
`;

