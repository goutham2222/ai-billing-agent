-- 1. Customers
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    preferred_language TEXT DEFAULT 'en',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Bills
CREATE TABLE bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    total_amount NUMERIC(12, 2) NOT NULL,
    items JSONB NOT NULL DEFAULT '[]',
    image_url TEXT,
    pdf_url TEXT,
    payment_status TEXT CHECK (payment_status IN ('paid', 'pending')) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Pending Actions (State Management for WhatsApp Button Clicks)
CREATE TABLE pending_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    whatsapp_message_id TEXT UNIQUE NOT NULL,
    bill_id UUID REFERENCES bills(id) ON DELETE CASCADE,
    owner_phone TEXT NOT NULL,
    action_type TEXT NOT NULL, -- 'confirm_payment'
    status TEXT DEFAULT 'awaiting_input', -- 'awaiting_input', 'completed', 'expired'
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
