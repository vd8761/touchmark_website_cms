import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Prisma client plus the Row-Level Security bridge.
 *
 * RLS (§4.4 safeguard 4) works off a session variable, so a query only sees a
 * tenant's rows if `app.workspace_id` is set on the *same* connection that runs
 * it. Prisma pools connections, so the variable must be set inside the same
 * transaction as the query — hence `withWorkspaceScope()`, which is the only
 * supported way to touch a tenant-owned table.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `work` in a transaction with the RLS session variables bound to this
   * workspace. Anything the callback reads is filtered by the database itself,
   * independently of whether the application remembered to add a WHERE clause.
   */
  async withWorkspaceScope<T>(
    workspaceId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // set_config(..., true) scopes the setting to the transaction, so it is
      // discarded when the pooled connection is handed to the next request.
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return work(tx);
    });
  }

  /** As above, for organisation-scoped (not workspace-scoped) work. */
  async withOrgScope<T>(
    orgId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
      return work(tx);
    });
  }

  /**
   * Escape hatch for genuinely cross-tenant work: the scheduler, the outbox
   * dispatcher, migrations, and the login path (which resolves a user before
   * any workspace exists). Named to be conspicuous in review and in grep.
   */
  async asSystem<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return work(tx);
    });
  }
}
