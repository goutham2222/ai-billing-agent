# AI-First WhatsApp Billing & Debt CRM Agent

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-000000?style=for-the-badge&logo=fastify&logoColor=white)](https://fastify.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com/)
[![Google Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?style=for-the-badge&logo=google%20gemini&logoColor=white)](https://ai.google.dev/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

An autonomous, multimodal AI assistant that transforms WhatsApp into a complete Kirana and retail store ledger. Shop owners can dictate voice notes, send photos of paper receipts, or type conversational shorthand in English, Hindi, or Telugu to extract line items, track udhaar (credit debt), generate branded PDF receipts, dispatch customer reminders, and run natural-language business analytics directly within a single WhatsApp conversation.

---

## ⚡ Quickstart & Testing Guide

### Prerequisites
- **Node.js**: v20.x or higher
- **Docker & Docker Compose**: For running Evolution API v2 gateway
- **Supabase Project**: Free or Pro project with PostgreSQL database and Storage enabled
- **Google Gemini API Key**: For multimodal extraction and Text-to-SQL analytics
- **Active WhatsApp Number**: Connected to the Evolution API instance

---

### Local Installation & Startup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/goutham2222/ai-billing-agent.git
   cd ai-billing-agent
   ```

2. **Install project dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Copy `.env.example` to `.env` and fill in your keys:
   ```bash
   cp .env.example .env
   ```
   Key environment variables required:
   ```env
   # Server
   FASTIFY_PORT=3000
   NODE_ENV=development

   # Evolution API (WhatsApp Gateway)
   EVOLUTION_API_URL=http://localhost:8085
   EVOLUTION_API_KEY=your_evolution_api_key
   BILLING_INSTANCE_NAME=billing-bot
   MANAGER_INSTANCE_NAME=manager-bot

   # Supabase Cloud
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
   SUPABASE_STORAGE_BUCKET=billing-media

   # Gemini API
   GEMINI_API_KEY=your_gemini_api_key
   GEMINI_MODEL=gemini-3.8-flash

   # Read-Only Database Connection (for Manager Text-to-SQL)
   READONLY_DATABASE_URL=postgresql://user:password@your-db-host:5432/postgres

   # Store Owner WhatsApp Phone Number (Country code + 10 digits)
   STORE_OWNER_PHONE=919876543210
   ```

4. **Start Evolution API Gateway (Docker):**
   ```bash
   cd infra
   docker compose up -d
   cd ..
   ```
   Open `http://localhost:8085` to scan the WhatsApp QR code and connect your instance.

5. **Start the Fastify Development Server:**
   ```bash
   npm run dev
   ```

6. **Reset / Clean-Slate Utility:**
   To wipe existing test rows from `pending_actions`, `bills`, `customers`, restart sequence counters back to 1, and clear storage buckets:
   ```bash
   npm run db:clean
   ```

---

### 🧪 Test Drive Cheat Sheet

Send the following messages directly to your connected WhatsApp bot:

| Feature / Scenario | Message to Send in WhatsApp | What Happens |
| :--- | :--- | :--- |
| **New Customer Bill (Udhaar)** | `Raghu 9876543210 2 packets salt 40, 1 dal 160 baki` | Extracts items, dynamically onboards Raghu, calculates ₹200 total, marks status as Pending Udhaar, and sends summary review card. |
| **Confirm Bill** | Reply `1` or `paid` or `jama`<br>Reply `2` or `udhaar` or `baki` | `1` records bill as Paid.<br>`2` records bill as Udhaar debt ledger and sends PDF invoice to customer. |
| **Existing Customer (Debt Balance)** | `Raghu 1 rice bag 1200 udhaar` | Detects Raghu as an **Existing Customer**, displays his previous outstanding debt (e.g. ₹200), and creates new draft. |
| **Anonymous Walk-in Customer** | `2 cold drinks 80` | Extracts 2 Cold Drinks (₹80), classifies as **Walk-in Customer (Anonymous)**. |
| **Walk-in Udhaar Guardrail** | Reply `2` on the Walk-in bill | ⛔ **Blocked:** System rejects credit: *"⚠️ Cannot assign Udhaar to an anonymous Walk-in Customer. Please provide customer name or phone."* |
| **Discard / Cancel Draft** | Reply `3` or `cancel` | Cancels draft bill immediately. |
| **Business Analytics (English)** | `? Who owes more than 100 rupees?` | Text-to-SQL engine runs safe `SELECT` query and formats customer debtors with amounts. |
| **Business Analytics (Sales)** | `Total sales today?` | Aggregates gross cleared revenue and outstanding debt for today in IST. |
| **Business Analytics (Vernacular)** | `Aaj ka hisaab?` or `Eroju ammakaalu enta?` | Multilingual intent router translates to SQL and returns analytical breakdown. |
| **Customer Payment Reminder** | `remind Raghu` | Looks up Raghu's pending debt and dispatches a polite WhatsApp reminder directly to his phone in his preferred language. |

---

## 🏗️ Architecture Overview

The backend operates on a single-chat, unified-intent reactive architecture. Incoming WhatsApp messages arrive via Evolution API webhooks, acknowledge immediately with HTTP 200 OK, and execute non-blocking pipelines in the background.

```mermaid
flowchart TD
    User["Store Owner / Customer (WhatsApp)"]
    Evo["Evolution API v2 Gateway (Docker)"]
    Webhook["Fastify Inbound Webhook (/webhook/billing)"]
    Router{"Unified Intent Classifier"}
    
    Extractor["Gemini 1.5 Flash Multimodal Extractor"]
    StateEngine["Pending Actions State Engine"]
    ManagerSQL["Manager Text-to-SQL Engine (Read-Only PG)"]
    Reminders["Customer Reminders Engine"]
    PDFGen["PDFKit Invoice Engine"]
    
    subgraph Storage["Supabase Cloud"]
        DB[("PostgreSQL Database: customers, bills, pending_actions")]
        BucketMedia[("Storage Bucket: billing-media (Raw Audio / Photos)")]
        BucketPDF[("Storage Bucket: invoices (Generated Receipts)")]
    end
    
    User -->|Voice / Image / Text / Commands| Evo
    Evo -->|Webhook POST (200 OK + Async)| Webhook
    Webhook --> Router
    
    Router -->|Bill Ingestion (Text / Audio / Photo)| Extractor
    Extractor -->|Structured JSON Bill| StateEngine
    StateEngine -->|Save Draft & Awaiting Confirmation| DB
    StateEngine -->|Dispatches Review Card| Evo
    
    Router -->|Shorthand Reply (1, 2, 3)| StateEngine
    StateEngine -->|Finalize Paid / Udhaar| DB
    StateEngine -->|Trigger Receipt| PDFGen
    PDFGen -->|Save PDF| BucketPDF
    PDFGen -->|Deliver PDF Document| Evo
    
    Router -->|Analytics Query (? / sales / debt)| ManagerSQL
    ManagerSQL -->|Sanitized SELECT Query| DB
    ManagerSQL -->|Natural Language Summary| Evo
    
    Router -->|Reminder Command (remind name)| Reminders
    Reminders -->|Fetch Pending Debt| DB
    Reminders -->|Polite WhatsApp Reminder| Evo
    
    Extractor -.->|Offload Media Binaries| BucketMedia
    Evo -->|Delivers to WhatsApp| User
```

### Dual-Storage Architecture
1. **`billing-media` (or `bills`) Bucket**: Stores raw binary streams (audio voice notes `.ogg`/`.opus`, camera receipt photos) downloaded from Evolution API before temporary WhatsApp CDN links expire.
2. **`invoices` Bucket**: Stores generated A4 PDF tax receipts (`bills/{billNo}_{timestamp}.pdf`) with permanent public URLs saved to `bills.pdf_url`.

---

## 🚀 Key Features & Implementation Details

### 1. Multimodal & Multilingual Ingestion
- **Audio Voice Notes**: Accepts `.ogg` and `.opus` voice messages, downloads binary buffers from Evolution API, and transcribes spoken Kirana ledger entries.
- **Photo Receipts**: Processes camera captures of handwritten chits and printed thermal receipts with OCR.
- **Vernacular Debt Semantics**: Powered by Google Gemini 1.5 Flash, recognizing regional debt terminology across English, Hindi, and Telugu:
  - **Debt / Udhaar Terms**: `baki`, `baaki`, `udhaar`, `lena hai`, `ivvali`, `ivvalsindi`, `appu`, `credit`, `due`, `balance`.
  - **Settled / Cash Terms**: `paid`, `jama`, `diya`, `de diya`, `cash`, `nagad`, `ichadu`, `icchesadu`, `chellinchadu`.

### 2. 3-Tier Customer Ledger CRM
- **Tier 1 (Existing Customer)**: Matched by 10-digit phone or case-insensitive `ILIKE` name. Dynamically computes outstanding debt balance across all unpaid bills:
  ```text
  👤 Customer: Raghu (Existing — Outstanding Udhaar: Rs. 200)
  ```
- **Tier 2 (New Customer)**: Identifier provided (name or phone) but not in database. Automatically inserts customer row with initial debt `0`:
  ```text
  👤 Customer: Raghu [New Customer Onboarded]
  ```
- **Tier 3 (Walk-in Customer)**: Applied when zero identifiers are provided. Enforces an anonymous cash-only profile:
  ```text
  👤 Customer: Walk-in Customer (Anonymous)
  ```
- **Walk-in Udhaar Guardrail**: Disallows assigning debt to anonymous walk-in customers. Replying `2` triggers:
  ```text
  ⚠️ Cannot assign Udhaar to an anonymous Walk-in Customer. Please provide customer name or phone.
  ```

### 3. Atomic State Engine & Single-Action Guardrail
- **Deterministic Shorthand**: Review summary card accepts simple replies:
  - `1` (or `paid`, `settled`, `jama`) ➔ Confirm Paid
  - `2` (or `udhaar`, `pending`, `baki`) ➔ Confirm Udhaar
  - `3` (or `cancel`, `reject`, `discard`) ➔ Discard Draft
- **Superseded Draft Protection**: Creating a new bill draft automatically marks any previous unconfirmed drafts for that store owner as `superseded`, ensuring strictly $\le 1$ active pending action at any time.
- **60-Second Finalization Lock**: If no draft is awaiting confirmation, replies within 60 seconds of a finalized bill return:
  ```text
  ⚠️ This bill has already been confirmed and finalized.
  ```
  Replies outside that window return:
  ```text
  No pending bill awaiting confirmation.
  ```
- **Quantity-Prefix Preservation**: Eliminates prefix ambiguities so messages like `"2 cold drinks 80"` extract as bills first rather than being misparsed as shorthand choice `2`.

### 4. Dynamic PDF Invoicing & Automated Reminders
- **Branded PDF Invoices**: Generates clean, formatted receipts using PDFKit featuring Store Name, Date, Bill Number, Itemized Line Table, Total, and visual badges (`PAID / SETTLED` in green, `PENDING UDHAAR` in amber).
- **Clean Owner Experience**: When a bill is confirmed, the store owner receives **only** a clean text confirmation message. The owner's WhatsApp is never spammed with PDF documents.
- **Customer Delivery**: If the customer has a valid phone number, the PDF document is sent directly to the customer's WhatsApp with a personalized greeting. For placeholder numbers (`newcust-`, `walkin-`), the PDF URL is stored in Supabase Storage silently (`PDF saved to records.`).
- **Customer Payment Reminders**: The owner can type `"remind Raghu"` or `"send reminder to Suresh"` to query their unsettled ledger balance and dispatch a polite reminder message in their preferred language.

### 5. Text-to-SQL Manager Analytics Engine
- **Natural Language Business Intelligence**: Store owners can query sales, inventory, and customer debts using everyday conversational language (e.g. `"? Who owes more than 500 rupees?"`, `"Total sales today?"`, `"Aaj ka hisaab?"`).
- **Strict Read-Only Guardrails**:
  - Only `SELECT` statements are allowed.
  - Queries containing `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, or multi-statement semicolons (`;`) are strictly blocked.
  - Access to PostgreSQL system tables (`pg_*`, `information_schema`) is blocked.
  - Session-level `SET TRANSACTION READ ONLY` with strict 3000ms statement timeout.
  - Output is clamped to 50 rows maximum to prevent token overflows.

---

## 🗄️ Database Schema

### PostgreSQL Schema Architecture (`Supabase`)

```sql
-- 1. Customers Table
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    preferred_language TEXT DEFAULT 'en', -- 'en', 'hi', 'te'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Bills Table
CREATE TABLE bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no SERIAL, -- Auto-incrementing integer bill identifier (e.g. 1, 2, 3...)
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    total_amount NUMERIC(12, 2) NOT NULL,
    items JSONB DEFAULT '[]', -- [{"name": "Sugar", "quantity": 2, "unit": "kg", "unitPrice": 45, "totalPrice": 90}]
    image_url TEXT,
    pdf_url TEXT,
    payment_status TEXT CHECK (payment_status IN ('paid', 'pending', 'cancelled')) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Pending Actions Table (Human-in-the-Loop State Machine)
CREATE TABLE pending_actions (
    whatsapp_message_id TEXT PRIMARY KEY,
    bill_data JSONB, -- Draft bill payload snapshot including customer tier & debt
    owner_phone TEXT,
    status TEXT DEFAULT 'awaiting_confirmation', -- 'awaiting_confirmation', 'completed', 'cancelled', 'superseded'
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 📂 Project Structure

```text
ai-billing-agent/
├── docs/                   # System documentation & PRD
│   ├── ARCHITECTURE.md     # Architecture specifications
│   ├── MIGRATION_READONLY.sql # PostgreSQL read-only user creation script
│   ├── PRD.md              # Product requirements document
│   └── SCHEMA.md           # Database schema documentation
├── infra/                  # Docker infrastructure for WhatsApp gateway
│   └── docker-compose.yml  # Evolution API v2, PostgreSQL, & Redis
├── scripts/                # Database maintenance & testing scripts
│   └── clean-slate.ts      # Supabase tables & storage reset utility (npm run db:clean)
├── src/
│   ├── config/             # Zod environment schema validation
│   │   └── env.ts
│   ├── lib/                # Core clients & connection pools
│   │   ├── db-readonly.ts  # Read-only PG pool with timeout & connection URI encoding
│   │   ├── evolution.ts    # Evolution API v2 WhatsApp client (text, media, polls)
│   │   ├── gemini.ts       # Gemini SDK client with exponential backoff & model fallbacks
│   │   └── supabase.ts     # Supabase admin client (Service Role)
│   ├── modules/
│   │   ├── billing/        # Ingestion, Gemini extraction, state engine, & routing
│   │   │   ├── bridge.ts   # Binary media offloader to Supabase Storage
│   │   │   ├── extractor.ts# Multimodal bill parser (text, audio, image)
│   │   │   ├── routes.ts   # Webhook listener, intent classifier, & shorthand router
│   │   │   ├── schemas.ts  # Zod validation schemas for line items & customer info
│   │   │   └── state.ts    # Draft persistence, confirmation logic, & 3-tier CRM
│   │   ├── invoicing/      # PDF receipt generation & customer debt reminders
│   │   │   ├── pdf-generator.ts # Branded PDFKit receipt builder
│   │   │   ├── reminders.ts     # Vernacular payment reminder dispatch
│   │   │   └── storage.ts       # Supabase Storage invoice bucket manager
│   │   ├── manager/        # Manager Text-to-SQL analytics engine
│   │   │   ├── executor.ts # AST/regex SQL guardrails & query execution
│   │   │   ├── routes.ts   # Manager endpoint & authorization
│   │   │   ├── schema-context.ts # Postgres DDL & business intelligence context
│   │   │   └── sql-generator.ts  # Text-to-SQL translation with Gemini
│   │   └── routing/        # Intent classification for single-account dual bots
│   │       └── classifier.ts# Linguistic regex & prefix detection
│   ├── types/
│   │   └── evolution.ts    # Evolution API webhook payload type definitions
│   └── index.ts            # Fastify application bootstrap & server listener
├── DEBUG_LOG.md            # Production incident log & root cause resolutions
├── package.json
└── tsconfig.json
```

---

## 🏆 Milestone Completion Status

| Stage | Milestone Description | Status |
| :---: | :--- | :---: |
| **Stage 1** | **Foundation & Inbound Webhook Pipeline**<br>Fastify server setup, Evolution API v2 webhook receiver, Supabase Storage binary offloading bridge. | ✅ **Complete** |
| **Stage 2** | **Multimodal Gemini Extraction Engine**<br>Multimodal parsing with Gemini 1.5 Flash (`@google/genai`) for text, voice notes (`.ogg`/`.opus`), and receipt images with Zod validation and multilingual vernacular debt detection (`baki`, `udhaar`, `ivvali`). | ✅ **Complete** |
| **Stage 3** | **State Engine & Atomic Confirmation Workflows**<br>Single active draft enforcement (`superseded`), deterministic text shorthand (`1`=Paid, `2`=Udhaar, `3`=Cancel), 3-tier customer CRM (Existing with debt, New Onboarded, Walk-in Anonymous), and Walk-in Udhaar guardrail. | ✅ **Complete** |
| **Stage 4** | **Manager Bot Text-to-SQL Engine**<br>Natural language queries translated to SQL via Gemini, executed over read-only PostgreSQL role, AST/regex guardrails enforcing strict `SELECT` only, zero destructive commands, and execution row/timeout clamps. | ✅ **Complete** |
| **Stage 5** | **Dynamic PDF Invoicing & WhatsApp Reminders**<br>Branded PDF generation using PDFKit, Supabase Storage `invoices` bucket integration, customer WhatsApp delivery with store owner text confirmation, and automated vernacular debt payment reminders. | ✅ **Complete** |

---

## 📜 License

MIT License. Built for modern Kirana and retail store digitization.
