import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { API_PREFIX, GATEWAY_PATH } from '@frequencia/shared';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from './config';
import './context';
import { connectDatabase, runMigrations } from './db/client';
import { errorHandler, unauthorized } from './errors';
import { GatewayBus } from './gateway/bus';
import { GatewayHub } from './gateway/hub';
import { PresenceService } from './gateway/presence';
import { labRoutes } from './lab/routes';
import { registerMetrics } from './metrics';
import { authRoutes } from './modules/auth/routes';
import { AuthService } from './modules/auth/service';
import { guildRoutes } from './modules/guilds/routes';
import { GuildService } from './modules/guilds/service';
import { messageRoutes } from './modules/messages/routes';
import { MessageService } from './modules/messages/service';
import { MediaLink } from './modules/voice/media-link';
import { voiceRoutes } from './modules/voice/routes';
import { VoiceAccess } from './modules/voice/voice-access';
import { VoiceStateStore } from './modules/voice/voice-state';
import { connectRedis } from './redis';

const WS_MAX_PAYLOAD_BYTES = 256 * 1024;

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    // Behind Caddy the client address comes from X-Forwarded-For.
    trustProxy: config.NODE_ENV === 'production',
    logger:
      config.NODE_ENV === 'test'
        ? false
        : {
            level: config.LOG_LEVEL,
            ...(config.NODE_ENV === 'development'
              ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
              : {}),
          },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  // --- infrastructure -----------------------------------------------------------------------
  const database = connectDatabase(config.DATABASE_URL);
  if (config.RUN_MIGRATIONS) await runMigrations(database.db);
  const { redis, subscriber, close: closeRedis } = connectRedis(config.REDIS_URL);

  // --- services -----------------------------------------------------------------------------
  const bus = new GatewayBus(redis, subscriber);
  await bus.start();
  // Presence entries outlive two missed heartbeats plus the resume window.
  const presence = new PresenceService(
    redis,
    config.GATEWAY_HEARTBEAT_MS * 2 + config.GATEWAY_RESUME_WINDOW_MS + 5000,
  );
  const voiceStates = new VoiceStateStore(redis);
  const live = { presence, voiceStates };
  const auth = new AuthService(database.db, redis, bus, config);
  const voice = new VoiceAccess({
    db: database.db,
    redis,
    bus,
    voiceStates,
    config,
    log: app.log,
  });
  const media = new MediaLink({
    url: config.MEDIA_INTERNAL_URL,
    sharedSecret: config.MEDIA_SHARED_SECRET,
    log: app.log,
    onConnected: (snapshot) => voice.resync(snapshot),
    onVoiceState: (event) => voice.applyVoiceState(event),
  });
  voice.attach(media);
  const guilds = new GuildService({ db: database.db, bus, live, voice });
  const messages = new MessageService(database.db, bus);
  const hub = new GatewayHub({ db: database.db, bus, auth, live, config, log: app.log });
  hub.start();
  media.start();

  app.decorate('ctx', {
    config,
    log: app.log,
    db: database.db,
    redis,
    bus,
    presence,
    voiceStates,
    auth,
    guilds,
    messages,
    voice,
    media,
    hub,
  });
  app.decorateRequest('auth');
  app.decorate('authenticate', async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const claims = token ? await auth.authenticate(token) : null;
    if (!claims) throw unauthorized();
    request.auth = claims;
  });

  app.addHook('onClose', async () => {
    media.stop();
    await hub.close();
    await closeRedis();
    await database.close();
  });

  // --- plugins ------------------------------------------------------------------------------
  await app.register(cors, { origin: config.CORS_ORIGINS, credentials: true });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    redis,
    nameSpace: 'ratelimit:',
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Frequência API',
        description:
          'REST API of Frequência. Realtime events are delivered over the WebSocket gateway ' +
          `at \`${API_PREFIX}${GATEWAY_PATH}\`; media signaling is served by the media service.`,
        version: '1.0.0',
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // --- routes -------------------------------------------------------------------------------
  registerMetrics(app);
  await app.register(
    async (api) => {
      api.get('/health', { schema: { hide: true } }, async () => ({
        status: 'ok',
        service: 'api',
        uptime: process.uptime(),
        media: media.connected,
      }));

      api.get(GATEWAY_PATH, { websocket: true, schema: { hide: true } }, (socket) =>
        hub.accept(socket),
      );

      await api.register(authRoutes);
      await api.register(guildRoutes);
      await api.register(messageRoutes);
      await api.register(voiceRoutes);
      if (config.LAB_ENABLED) await api.register(labRoutes);
    },
    { prefix: API_PREFIX },
  );

  return app;
}
