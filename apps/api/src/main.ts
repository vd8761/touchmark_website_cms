import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { JsonLogger } from './observability/json-logger';
import { buildOpenApi } from './openapi';

/**
 * Everything the API owns. The admin portal is a single-page app, so any path
 * *not* in this list has to fall through to its index.html for client-side
 * routing to work — and any path that is must never be answered with HTML.
 */
const API_PREFIXES = ['/admin/v1', '/v1', '/uploads/local', '/webhooks', '/docs'];

function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

async function bootstrap(): Promise<void> {
  // Installed before the module graph initialises, so provider bootstrap logs
  // are structured too — those are the lines you need when a deploy fails to
  // come up, and they are exactly the ones a later `useLogger` would miss.
  const app = await NestFactory.create(AppModule, { logger: JsonLogger.create() });
  const config = app.get(ConfigService);

  app.use(cookieParser());

  // Provider webhooks are signed over the exact bytes received. Re-serialising
  // parsed JSON changes key order and whitespace, which invalidates the
  // signature — so the raw body is kept alongside the parsed one, for those
  // routes only.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        if (req.url?.startsWith('/webhooks/')) {
          (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
        }
      },
    }),
  );

  // §18.2 security headers. CSP is set here rather than at the edge so a
  // self-hosted deployment behind a plain reverse proxy still gets it.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // Media lives in an object store — S3, R2, or a CDN in front of one —
          // and the portal renders thumbnails and previews straight from it, so
          // `'self'` alone would show a library of broken images. `https:`
          // rather than a fixed host because the bucket, its endpoint and any
          // CDN in front of it are all deployment choices, and presigned URLs
          // are served from a different host to the public base URL.
          // Widening this for *images only* costs little: an <img> cannot
          // execute anything.
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          // Uploads go direct to storage (§4.2): the browser PUTs the file to a
          // presigned URL on S3, R2 or MinIO, which is a different origin from
          // the portal. Without this, `connect-src` inherits `'self'` and the
          // browser blocks that PUT before it is sent — the upload fails with
          // nothing in the network tab and nothing in the API log. Widening it
          // for images alone was not enough, because reading a thumbnail and
          // writing a file are different directives.
          connectSrc: ["'self'", 'https:'],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      // The portal is served from this same origin, and cross-origin isolation
      // would block those object-store images outright.
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // §14.6: the Admin API allows the portal's own origins only — never `*`,
  // because these requests carry session cookies.
  const origins = (config.get<string>('ADMIN_CORS_ORIGINS') ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origins,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject rather than strip unknown fields: silently ignoring a
      // misspelled field is how a caller ends up believing a setting applied.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  buildOpenApi(app);

  serveAdminPortal(app, config);

  const port = Number(config.get('PORT') ?? 4000);
  await app.listen(port);

  new Logger('Bootstrap').log(`API listening on http://localhost:${port} (docs at /docs)`);
}

/**
 * Serves the built admin portal from this same process, when it has been built.
 *
 * One origin for the portal and the API is not a convenience — it is what makes
 * authentication work at all. Session cookies are `SameSite=Lax`, which browsers
 * refuse to send on cross-site requests, so a portal on a different host would
 * sign in successfully and then get 401 on every request after it. CORS does not
 * help: it governs whether the response may be read, not whether the cookie is
 * sent.
 *
 * Skipped silently when `apps/admin/dist` is absent, which is the normal state
 * in development — there the Vite dev server serves the portal and proxies
 * `/admin` and `/v1` here, producing the same single origin.
 */
function serveAdminPortal(
  app: Awaited<ReturnType<typeof NestFactory.create>>,
  config: ConfigService,
): void {
  const logger = new Logger('AdminPortal');

  const configured = config.get<string>('ADMIN_PORTAL_DIST');
  // Resolved relative to the compiled file (apps/api/dist), so it holds whether
  // the process is started from the repo root or from apps/api.
  const distDir = configured
    ? resolve(configured)
    : resolve(__dirname, '..', '..', 'admin', 'dist');

  if (!existsSync(join(distDir, 'index.html'))) {
    logger.log(`No admin portal build at ${distDir} — serving the API only.`);
    return;
  }

  const server = app.getHttpAdapter().getInstance() as express.Express;

  // Hashed filenames are immutable, so they are cached hard; index.html must not
  // be, or a deploy leaves browsers holding a build whose assets are gone.
  server.use(
    express.static(distDir, {
      index: false,
      maxAge: '1y',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  server.use((req, res, next) => {
    // An unknown API path must still 404 as JSON. Answering it with the portal's
    // HTML would turn every typo'd endpoint into a 200, which is precisely the
    // failure that makes a broken integration look like a broken client.
    if (isApiPath(req.path)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!req.accepts('html')) return next();

    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(distDir, 'index.html'));
  });

  logger.log(`Serving the admin portal from ${distDir}.`);
}

void bootstrap();
