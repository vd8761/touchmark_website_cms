export const API_KEY_SCOPES = [
  'content.read',
  'content.preview',
  'media.read',
  'subscriber.write',
  'subscriber.read',
  'form.submit',
  'search.read',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const PUBLISHABLE_API_KEY_SCOPES = [
  'content.read',
  'media.read',
  'form.submit',
  'search.read',
] as const satisfies readonly ApiKeyScope[];

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

export function isPublishableApiKeyScope(value: ApiKeyScope): boolean {
  return (PUBLISHABLE_API_KEY_SCOPES as readonly string[]).includes(value);
}
