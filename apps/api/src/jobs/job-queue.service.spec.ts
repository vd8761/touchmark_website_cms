import { ConfigService } from '@nestjs/config';

import { JobQueueService } from './job-queue.service';

const prisma = {} as never;

describe('JobQueueService', () => {
  it('stays inert while tests are running', () => {
    const service = new JobQueueService(prisma, new ConfigService({ NODE_ENV: 'test' }));

    expect(service.isEnabled()).toBe(false);
    expect(service.isWorkerEnabled()).toBe(false);
  });

  it('allows producers without starting workers', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      const service = new JobQueueService(
        prisma,
        new ConfigService({ JOB_WORKER_ENABLED: 'false' }),
      );

      // An instance may queue work without also draining it — that is how you
      // run web instances that produce jobs and separate workers that consume.
      expect(service.isEnabled()).toBe(true);
      expect(service.isWorkerEnabled()).toBe(false);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });
});
