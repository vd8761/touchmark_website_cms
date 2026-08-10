import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { buildOpenApi } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
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
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
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

  const port = Number(config.get('PORT') ?? 4000);
  await app.listen(port);

  new Logger('Bootstrap').log(`API listening on http://localhost:${port} (docs at /docs)`);
}

void bootstrap();
