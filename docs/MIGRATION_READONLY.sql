-- SQL Migration: Setup Read-Only PostgreSQL Role for AI Manager Bot
-- Run this script in the Supabase SQL Editor if provisioning a dedicated unprivileged user.

-- 1. Create the read-only role with a secure password
CREATE ROLE readonly_user WITH LOGIN PASSWORD 'CHANGE_THIS_TO_SECURE_PASSWORD';

-- 2. Grant database connection permissions
GRANT CONNECT ON DATABASE postgres TO readonly_user;

-- 3. Grant schema usage permissions
GRANT USAGE ON SCHEMA public TO readonly_user;

-- 4. Grant SELECT only on the core CRM and billing tables
GRANT SELECT ON TABLE public.customers TO readonly_user;
GRANT SELECT ON TABLE public.bills TO readonly_user;
GRANT SELECT ON TABLE public.pending_actions TO readonly_user;

-- 5. Automatically grant SELECT on future tables created in public schema
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly_user;

-- 6. Enforce hard statement timeout on this role for query safety
ALTER ROLE readonly_user SET statement_timeout = '3000ms';
ALTER ROLE readonly_user SET default_transaction_read_only = 'on';

-- Usage in .env:
-- READONLY_DATABASE_URL=postgresql://readonly_user:CHANGE_THIS_TO_SECURE_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres
