# System Architecture: AI Billing Agent

## High-Level Architecture

The system operates as a decentralized, AI-first WhatsApp Billing and Debt CRM backend designed to process retail ledger operations across dual WhatsApp bot interfaces.

```mermaid
flowchart TD
    subgraph WhatsApp["Evolution API Instances"]
        B_BOT["Billing Bot (Ingestion)"]
        M_BOT["Manager Bot (BI / Text-to-SQL)"]
    end

    subgraph Backend["Fastify Backend (Node 20+ / TS)"]
        WEBHOOK_B["/webhook/billing"]
        WEBHOOK_M["/webhook/manager"]
        BRIDGE["Binary Offloader Bridge"]
        GEMINI["Gemini 1.5 Flash Ingestion"]
        STATE["Pending Actions State Engine"]
        T2SQL["Text-to-SQL Engine + Guardrails"]
    end

    subgraph Supabase["Supabase Cloud"]
        STORAGE[("Supabase Storage: billing-media")]
        DB_RW[("PostgreSQL (RW - Service Role)")]
        DB_RO[("PostgreSQL (RO - Restricted Role)")]
    end

    B_BOT -->|Media / Text Webhook| WEBHOOK_B
    WEBHOOK_B -->|Async Queue| BRIDGE
    BRIDGE -->|Persist Decrypted Binary| STORAGE
    BRIDGE -->|Media Buffer + URL| GEMINI
    GEMINI -->|Structured Bill Data| STATE
    STATE -->|Insert Draft & Pending Action| DB_RW
    STATE -->|Send Confirmation Buttons| B_BOT

    M_BOT -->|Natural Language Query| WEBHOOK_M
    WEBHOOK_M -->|Prompt with Schema| T2SQL
    T2SQL -->|Sanitized SELECT Query| DB_RO
    T2SQL -->|Format WhatsApp Response| M_BOT
```

## Core Components

1. **Evolution API Gateway**: Connects directly to WhatsApp web sockets and delivers webhooks for incoming text, audio voice notes, handwritten receipts, and interactive button replies.
2. **Binary Offloading Bridge**: Downloads media binaries immediately before temporary WhatsApp CDN media URLs expire and uploads them to Supabase Storage.
3. **Gemini 1.5 Flash Ingestion**: Multimodal and multilingual (English, Hindi, Telugu) parsing with Zod schema validation and retail debt term normalization (`baki`, `udhaar`, `pending`).
4. **State Engine (`pending_actions`)**: Manages confirmation workflows (`Mark as Paid`, `Confirm Pending`, `Edit / Reject`) without in-memory state.
5. **Manager Bot Text-to-SQL Engine**: Direct read-only database role connection with AST query sanitization, timeouts, and row clamps.
