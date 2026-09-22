import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  FASTIFY_PORT: z
    .string()
    .default('3000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().positive()),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  
  // Evolution API
  EVOLUTION_API_URL: z.string().url({ message: 'EVOLUTION_API_URL must be a valid URL' }),
  EVOLUTION_API_KEY: z.string().min(1, { message: 'EVOLUTION_API_KEY is required' }),
  BILLING_INSTANCE_NAME: z.string().min(1, { message: 'BILLING_INSTANCE_NAME is required' }),
  MANAGER_INSTANCE_NAME: z.string().min(1, { message: 'MANAGER_INSTANCE_NAME is required' }),

  // Supabase
  SUPABASE_URL: z.string().url({ message: 'SUPABASE_URL must be a valid URL' }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, { message: 'SUPABASE_SERVICE_ROLE_KEY is required' }),
  SUPABASE_STORAGE_BUCKET: z.string().default('billing-media'),

  // Gemini API
  GEMINI_API_KEY: z.string().min(1, { message: 'GEMINI_API_KEY is required' }),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),

  // Read-only database connection for Manager Text-to-SQL (Stage 4)
  READONLY_DATABASE_URL: z.string().optional(),

  // Store owner phone for notifications/authorizations
  STORE_OWNER_PHONE: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid or missing environment variables:');
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
