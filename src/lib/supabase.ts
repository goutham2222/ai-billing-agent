import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

/**
 * Supabase Admin Client initialized with the Service Role Key.
 * Bypasses RLS for backend operations.
 */
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
