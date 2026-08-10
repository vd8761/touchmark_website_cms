import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { JOB_NAMES } from '../jobs/job-names';
import { JobQueueService } from '../jobs/job-queue.service';
import { EntriesService } from './entries.service';

/**
 * The `publish-scheduled-content` job of spec §4.6, every minute.
 *
 * The schedule lives in the `jobs` table, so several API instances share one
 * schedule rather than each running its own interval. The work is idempotent
 * anyway, so a retry or a rare overlap cannot double-publish.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);
  private running = false;

  constructor(
    private readonly entries: EntriesService,
    private readonly jobs: JobQueueService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Tests drive tick() directly; a background worker there would make them
    // non-deterministic and leak open handles.
    if (this.config.get('NODE_ENV') === 'test' || this.config.get('DISABLE_SCHEDULER') === 'true') {
      this.logger.log('Scheduler disabled.');
      return;
    }
    if (!this.jobs.isEnabled()) {
      this.logger.log('Scheduler disabled because the job queue is disabled.');
      return;
    }

    this.jobs.registerRecurring(JOB_NAMES.publishScheduledContent, 60_000, async () => {
      await this.tick();
    });
    this.logger.log('Scheduler registered.');
  }

  async tick(now = new Date()): Promise<{ published: number; unpublished: number }> {
    // A slow sweep must not overlap itself and double the database load.
    if (this.running) return { published: 0, unpublished: 0 };
    this.running = true;

    try {
      const published = await this.entries.publishDue(now);
      const unpublished = await this.entries.unpublishExpired(now);

      if (published || unpublished) {
        this.logger.log(`Scheduler: published ${published}, unpublished ${unpublished}.`);
      }

      return { published, unpublished };
    } catch (error) {
      // The queue retries the job; one failing sweep must not stop future
      // scheduled publishing.
      this.logger.error(`Scheduler tick failed: ${(error as Error).message}`);
      return { published: 0, unpublished: 0 };
    } finally {
      this.running = false;
    }
  }
}
