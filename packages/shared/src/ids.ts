/**
 * Public resource identifiers.
 *
 * The data model (§5) stores UUID v7 primary keys — time-sortable, index-friendly,
 * and what Postgres wants. Appendix B requires the *API* to expose prefixed base62
 * ids like `ce_01J8XQ2M4K7N`.
 *
 * These are reconciled by encoding, not by a second column: the public id is a
 * reversible base62 rendering of the same UUID with a type prefix. So
 * `decodePublicId('ce_...')` gives back the UUID the database stores, and there
 * is no id column to keep in sync.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = BigInt(62);

export const ID_PREFIXES = {
  user: 'usr',
  organisation: 'org',
  organisation_member: 'om',
  workspace: 'ws',
  workspace_member: 'wm',
  invitation: 'inv',
  session: 'sess',
  audit_log: 'aud',
  content_type: 'ct',
  content_field: 'cf',
  content_entry: 'ce',
  content_version: 'cv',
  taxonomy: 'tax',
  taxonomy_term: 'tt',
  menu: 'mn',
  media_asset: 'md',
  media_folder: 'mf',
  subscriber: 'sub',
  list: 'ls',
  segment: 'seg',
  form: 'frm',
  form_submission: 'fs',
  sender_identity: 'si',
  sending_domain: 'sd',
  email_template: 'tpl',
  campaign: 'cmp',
  automation: 'auto',
  api_key: 'key',
  webhook: 'wh',
  request: 'req',
} as const;

export type ResourceKind = keyof typeof ID_PREFIXES;

function encodeBase62(value: bigint): string {
  if (value === BigInt(0)) return '0';
  let out = '';
  let n = value;
  while (n > BigInt(0)) {
    out = ALPHABET[Number(n % BASE)] + out;
    n = n / BASE;
  }
  return out;
}

function decodeBase62(value: string): bigint {
  let n = BigInt(0);
  for (const char of value) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base62 character: ${char}`);
    n = n * BASE + BigInt(index);
  }
  return n;
}

/** UUID (canonical, hyphenated) → `prefix_base62`. */
export function encodePublicId(kind: ResourceKind, uuid: string): string {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`Not a UUID: ${uuid}`);
  }
  return `${ID_PREFIXES[kind]}_${encodeBase62(BigInt('0x' + hex))}`;
}

/** `prefix_base62` → UUID. Throws if the prefix does not match `kind`. */
export function decodePublicId(kind: ResourceKind, publicId: string): string {
  const expected = ID_PREFIXES[kind];
  const separator = publicId.indexOf('_');
  if (separator === -1) throw new Error(`Malformed id: ${publicId}`);

  const prefix = publicId.slice(0, separator);
  if (prefix !== expected) {
    throw new Error(`Expected a ${expected}_ id, received ${prefix}_`);
  }

  const hex = decodeBase62(publicId.slice(separator + 1)).toString(16).padStart(32, '0');
  if (hex.length > 32) throw new Error(`Malformed id: ${publicId}`);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** True when `publicId` is well-formed for `kind`. Never throws. */
export function isPublicId(kind: ResourceKind, publicId: string): boolean {
  try {
    decodePublicId(kind, publicId);
    return true;
  } catch {
    return false;
  }
}
