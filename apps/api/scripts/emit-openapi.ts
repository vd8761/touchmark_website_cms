/**
 * Writes generated OpenAPI documents without starting a listener.
 *
 * Spec section 15 requires OpenAPI to be generated from code, not maintained by
 * hand. Emitting both documents in CI means missing decorators or undocumented
 * endpoints fail early.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { buildAdminDocument, buildDeliveryDocument } from '../src/openapi';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const adminDocument = buildAdminDocument(app);
  const deliveryDocument = buildDeliveryDocument(app);
  const adminOutputPath = join(__dirname, '..', 'openapi-admin.json');
  const deliveryOutputPath = join(__dirname, '..', 'openapi-delivery.json');

  writeFileSync(adminOutputPath, JSON.stringify(adminDocument, null, 2));
  writeFileSync(deliveryOutputPath, JSON.stringify(deliveryDocument, null, 2));

  const undocumented = [
    ...undocumentedOperations('admin', adminDocument),
    ...undocumentedOperations('delivery', deliveryDocument),
  ];

  await app.close();

  if (undocumented.length) {
    console.error('Endpoints missing documentation:\n  ' + undocumented.join('\n  '));
    process.exit(1);
  }

  console.log(
    `Wrote ${adminOutputPath} (${Object.keys(adminDocument.paths ?? {}).length} paths) and ` +
      `${deliveryOutputPath} (${Object.keys(deliveryDocument.paths ?? {}).length} paths).`,
  );
}

function undocumentedOperations(label: string, document: { paths?: Record<string, unknown> }): string[] {
  const undocumented: string[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (typeof operation !== 'object' || operation === null) continue;
      const op = operation as { summary?: string; responses?: Record<string, unknown> };
      if (!op.summary) undocumented.push(`${label}: ${method.toUpperCase()} ${path} - no summary`);
      if (!op.responses || Object.keys(op.responses).length === 0) {
        undocumented.push(`${label}: ${method.toUpperCase()} ${path} - no documented responses`);
      }
    }
  }
  return undocumented;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
