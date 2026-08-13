import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { AuditService } from './audit/audit.service';
import { ApiRequestLogsController } from './api-keys/api-request-logs.controller';
import { ApiKeysController } from './api-keys/api-keys.controller';
import { ApiKeyGuard } from './api-keys/api-key-auth.guard';
import { ApiKeysService } from './api-keys/api-keys.service';
import { ApiRequestLogMiddleware } from './api-keys/api-request-log.middleware';
import { DeliveryAudienceController } from './api-keys/delivery-audience.controller';
import { DeliveryAudienceService } from './api-keys/delivery-audience.service';
import { DeliveryContentController } from './api-keys/delivery-content.controller';
import { DeliveryContentService } from './api-keys/delivery-content.service';
import { DeliveryController } from './api-keys/delivery.controller';
import { AdminPreviewController, DeliveryPreviewController } from './api-keys/preview.controller';
import { PreviewService } from './api-keys/preview.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { PasswordService } from './auth/password.service';
import { PermissionsGuard } from './auth/permissions.guard';
import { RequestContextGuard } from './auth/request-context.guard';
import { TokenService } from './auth/token.service';
import { EnvelopeInterceptor } from './common/envelope.interceptor';
import { ApiExceptionFilter } from './common/exception.filter';
import { HealthController } from './common/health.controller';
import { MailService } from './common/mail.service';
import { PlatformAdminsService } from './common/platform-admins.service';
import { PrismaService } from './common/prisma.service';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { CryptoService } from './common/crypto.service';
import { ContentTypesController, EntriesController } from './content/content.controller';
import { ContentTypesService } from './content/content-types.service';
import { EntriesService } from './content/entries.service';
import { SchedulerService } from './content/scheduler.service';
import {
  MenusController,
  TaxonomiesController,
  TermsController,
} from './content/taxonomy.controller';
import { MenusService } from './content/menus.service';
import { TaxonomiesService } from './content/taxonomies.service';
import { LocalUploadController, MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { StorageService } from './media/storage';
import { EmailConfigurationsController, WorkspaceEmailController } from './email/email.controller';
import { EmailConfigService } from './email/email-config.service';
import { EmailWebhookController } from './email/email-webhook.controller';
import { SenderIdentityService } from './email/sender-identity.service';
import { EventsService } from './events/events.service';
import { JobQueueService } from './jobs/job-queue.service';
import { PurgeService } from './jobs/purge.service';
import { HttpObservabilityInterceptor } from './observability/http-observability.interceptor';
import { MetricsController } from './observability/metrics.controller';
import { MetricsService } from './observability/metrics.service';
import {
  InvitationsController,
  OrganisationsController,
} from './organisations/organisations.controller';
import { OrganisationsService } from './organisations/organisations.service';
import {
  OrgWorkspacesController,
  WorkspacesController,
} from './workspaces/workspaces.controller';
import { WorkspacesService } from './workspaces/workspaces.service';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WebhooksService } from './webhooks/webhooks.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('ACCESS_TOKEN_TTL') ?? '15m' },
      }),
    }),
  ],
  controllers: [
    HealthController,
    MetricsController,
    DeliveryController,
    DeliveryContentController,
    DeliveryAudienceController,
    DeliveryPreviewController,
    AuthController,
    OrganisationsController,
    InvitationsController,
    OrgWorkspacesController,
    WorkspacesController,
    WebhooksController,
    EmailConfigurationsController,
    WorkspaceEmailController,
    EmailWebhookController,
    ApiKeysController,
    ApiRequestLogsController,
    AdminPreviewController,
    ContentTypesController,
    EntriesController,
    TaxonomiesController,
    TermsController,
    MenusController,
    MediaController,
    LocalUploadController,
  ],
  providers: [
    PrismaService,
    PlatformAdminsService,
    CryptoService,
    MailService,
    AuditService,
    ApiKeysService,
    ApiKeyGuard,
    ApiRequestLogMiddleware,
    DeliveryContentService,
    DeliveryAudienceService,
    PreviewService,
    EventsService,
    JobQueueService,
    PasswordService,
    TokenService,
    AuthService,
    OrganisationsService,
    WorkspacesService,
    WebhooksService,
    EmailConfigService,
    SenderIdentityService,
    ContentTypesService,
    EntriesService,
    SchedulerService,
    TaxonomiesService,
    MenusService,
    StorageService,
    MediaService,
    // Registered after StorageService and MediaService: the purge job deletes
    // stored objects before the rows that point at them.
    PurgeService,

    // Order matters. RequestContextGuard resolves who is asking and what they
    // may do (§3.4 layer 1); PermissionsGuard then enforces it (layer 2). Both
    // are global, so a new route is protected by default rather than by
    // remembering to decorate it.
    { provide: APP_GUARD, useClass: RequestContextGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    MetricsService,

    // Registered before the envelope so the measured duration covers response
    // serialisation too — the part a client actually waits for.
    { provide: APP_INTERCEPTOR, useClass: HttpObservabilityInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    consumer.apply(ApiRequestLogMiddleware).forRoutes('v1/*');
  }
}
