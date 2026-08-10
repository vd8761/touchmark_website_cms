export const JOB_QUEUE_NAME = 'cms-jobs';

export const JOB_NAMES = {
  publishScheduledContent: 'publish-scheduled-content',
  campaignPrepare: 'campaign-prepare',
  campaignSendBatch: 'campaign-send-batch',
  automationTick: 'automation-tick',
  ingestEspEvents: 'ingest-esp-events',
  subscriberImport: 'subscriber-import',
  subscriberExport: 'subscriber-export',
  webhookDeliver: 'webhook-deliver',
  analyticsRollup: 'analytics-rollup',
  mediaTransform: 'media-transform',
  purgeSoftDeleted: 'purge-soft-deleted',
  keyUsageFlush: 'key-usage-flush',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

const KNOWN_JOB_NAMES = new Set<string>(Object.values(JOB_NAMES));

export function isJobName(name: string): name is JobName {
  return KNOWN_JOB_NAMES.has(name);
}
