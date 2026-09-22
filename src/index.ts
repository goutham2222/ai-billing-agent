import Fastify from 'fastify';
import { env } from './config/env.js';
import { billingRoutes } from './modules/billing/routes.js';

async function bootstrap() {
  const server = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'info' : 'warn',
      transport:
        env.NODE_ENV === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
  });

  // Health check endpoint
  server.get('/health', async (_req, reply) => {
    return reply.status(200).send({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Register Webhook Routes
  await server.register(billingRoutes);

  // Graceful shutdown handling
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, async () => {
      server.log.info(`Received ${signal}. Shutting down gracefully...`);
      try {
        await server.close();
        server.log.info('Server closed successfully.');
        process.exit(0);
      } catch (err) {
        server.log.error({ err }, 'Error during graceful shutdown');
        process.exit(1);
      }
    });
  }

  // Start the server
  try {
    const address = await server.listen({
      port: env.FASTIFY_PORT,
      host: '0.0.0.0',
    });
    server.log.info(`🚀 Fastify server listening at ${address}`);
    server.log.info(`📦 Billing Webhook available at: ${address}/webhook/billing`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

bootstrap();
