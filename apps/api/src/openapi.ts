import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * §15.1: "The OpenAPI 3.1 document is generated from code, never hand-maintained."
 *
 * Two documents are emitted because they serve different audiences (§15.1):
 * `openapi-admin.json` (this file) and `openapi-delivery.json`, which appears
 * with the Delivery API in Phase 2.
 *
 * Generating from the very first endpoint is a §19 sequencing note: "Hand-written
 * specs drift within two sprints and never recover."
 *
 * The required permission for each operation is not restated here — it is
 * emitted as `x-required-permission` by the same @RequirePermission decorator
 * the guard reads, so documentation and enforcement cannot disagree.
 */

export function buildAdminDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('CMS Platform Admin API')
    .setVersion('1.0.0')
    .setDescription(
      [
        'Session-authenticated management API for the admin portal.',
        '',
        'Published, but versioned separately from the Delivery API and documented as ' +
          'lower-stability (Open Decision #10). The Delivery API backward-compatibility ' +
          'contract of §14.7 does not apply here.',
        '',
        'All successful responses use the envelope `{ data, meta }`. All errors use ' +
          '`{ error: { type, code, message, detail, docs_url, request_id } }` — quote ' +
          '`request_id` in support requests.',
        '',
        'Operations carry `x-required-permission` (or `x-required-org-permission`) naming ' +
          'the exact permission the caller needs.',
      ].join('\n'),
    )
    .setContact('API Support', 'https://docs.yourcms.com', 'api@yourcms.com')
    .addCookieAuth('access_token', { type: 'apiKey', in: 'cookie', name: 'access_token' })
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'Delivery API key as `Bearer <api_key>`.',
      },
      'deliveryApiKey',
    )
    .addServer('http://localhost:4000', 'Local development')
    .addTag('Auth', 'Sign in, sessions, password and email verification')
    .addTag('Organisations', 'Tenants, members, invitations, ownership')
    .addTag('Workspaces', 'Sites — the isolation boundary. Labelled "Sites" in the UI.')
    .addTag('Utility', 'Health and diagnostics')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    // §15.2 item 2: operationId in camelCase — this becomes the SDK method name.
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
  });

  document.openapi = '3.1.0';
  return document;
}

export function buildDeliveryDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('CMS Platform Delivery API')
    .setVersion('1.0.0')
    .setDescription(
      [
        'API-key-authenticated public API for websites, apps and embeds.',
        '',
        'All successful responses use the envelope `{ data, meta }`. All errors use ' +
          '`{ error: { type, code, message, detail, docs_url, request_id } }`.',
        '',
        'Operations carry `x-required-api-scope` naming the exact API-key scope required.',
      ].join('\n'),
    )
    .setContact('API Support', 'https://docs.yourcms.com', 'api@yourcms.com')
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'Send `Bearer <api_key>`.',
      },
      'deliveryApiKey',
    )
    .addServer('http://localhost:4000', 'Local development')
    .addTag('Delivery', 'Published content, media, forms, subscribers and preview tokens')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
  });

  document.openapi = '3.1.0';
  document.paths = Object.fromEntries(
    Object.entries(document.paths ?? {}).filter(([path]) => path.startsWith('/v1/')),
  );
  return document;
}

export function buildOpenApi(app: INestApplication): void {
  SwaggerModule.setup('docs', app, buildAdminDocument(app), {
    swaggerOptions: { persistAuthorization: true, docExpansion: 'none', filter: true },
    customSiteTitle: 'CMS Platform — Admin API',
    jsonDocumentUrl: 'docs/openapi-admin.json',
  });
}
