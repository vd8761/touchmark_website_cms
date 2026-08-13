import { createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage behind one interface (§4.3: "S3-compatible — AWS S3, R2, MinIO").
 *
 * Uploads go **direct to storage** (§4.2), never through the API process: a
 * 200MB video streamed through Node would occupy a request worker for the whole
 * transfer and cap throughput at whatever the API can proxy. The client asks for
 * a presigned URL, uploads to it, then tells us it finished.
 *
 * Two drivers, same contract:
 *   * `s3`    — used when S3_BUCKET is set. The real path.
 *   * `local` — the default, so `npm run dev` works with no cloud account and no
 *               extra container. It presigns a URL on this API instead, which
 *               keeps the *client-side* flow byte-for-byte identical to S3.
 */

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  /** Seconds until the URL stops working. */
  expiresIn: number;
}

export interface StoredObject {
  sizeBytes: number;
  contentType: string;
}

export interface StorageDriver {
  readonly name: string;
  presignUpload(key: string, contentType: string): Promise<PresignedUpload>;
  head(key: string): Promise<StoredObject | null>;
  publicUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
  /**
   * Removes every object under a key prefix. Used by the purge job when a site's
   * 30-day window expires (§6.3) — deleting the rows without this would leave
   * the objects paid for and orphaned, with nothing left pointing at them.
   *
   * Returns the number of objects removed.
   */
  deletePrefix(prefix: string): Promise<number>;
  read(key: string): Promise<Readable>;
}

const UPLOAD_TTL_SECONDS = 900;

@Injectable()
export class StorageService implements OnModuleInit, StorageDriver {
  private readonly logger = new Logger(StorageService.name);
  private driver!: StorageDriver;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const bucket = this.config.get<string>('S3_BUCKET');

    this.driver = bucket
      ? new S3Driver(this.config, bucket)
      : new LocalDiskDriver(this.config);

    this.logger.log(`Media storage driver: ${this.driver.name}`);
  }

  get name(): string {
    return this.driver.name;
  }

  /**
   * The local driver, when it is the active one. Only the local upload receiver
   * needs this — with S3 the client uploads to AWS and no route of ours is
   * involved at all.
   */
  get local(): LocalDiskDriver | null {
    return this.driver instanceof LocalDiskDriver ? this.driver : null;
  }

  /**
   * Keys are always prefixed with the workspace id. Two reasons: a bucket
   * listing is then partitioned by tenant, and a lifecycle rule or a purge can
   * target one workspace's objects by prefix when a site is deleted (§6.3).
   */
  /** The prefix holding every object owned by one site. */
  static workspacePrefix(workspaceId: string): string {
    return `ws/${workspaceId}/`;
  }

  static keyFor(workspaceId: string, assetId: string, filename: string): string {
    const safe = filename
      .replace(/[^\w.\- ]+/g, '_')
      .replace(/\s+/g, '-')
      .slice(-120);
    return `ws/${workspaceId}/${assetId}/${safe}`;
  }

  presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
    return this.driver.presignUpload(key, contentType);
  }

  head(key: string): Promise<StoredObject | null> {
    return this.driver.head(key);
  }

  publicUrl(key: string): Promise<string> {
    return this.driver.publicUrl(key);
  }

  delete(key: string): Promise<void> {
    return this.driver.delete(key);
  }

  deletePrefix(prefix: string): Promise<number> {
    return this.driver.deletePrefix(prefix);
  }

  read(key: string): Promise<Readable> {
    return this.driver.read(key);
  }
}

// ---------------------------------------------------------------------------

class S3Driver implements StorageDriver {
  readonly name = 's3';
  private readonly client: S3Client;
  private readonly cdnBase?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly bucket: string,
  ) {
    this.cdnBase = config.get<string>('S3_PUBLIC_BASE_URL');
    this.client = new S3Client({
      region: config.get<string>('S3_REGION') ?? 'us-east-1',
      // Set for MinIO, R2 and other S3-compatible services.
      endpoint: config.get<string>('S3_ENDPOINT') || undefined,
      // Path-style is required by MinIO and harmless on AWS.
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE') === 'true',
      credentials: config.get<string>('S3_ACCESS_KEY_ID')
        ? {
            accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
            secretAccessKey: config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
          }
        : undefined,
    });
  }

  async presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: UPLOAD_TTL_SECONDS },
    );

    return {
      url,
      method: 'PUT',
      // Content-Type is part of the signature, so the client must send exactly
      // this value or S3 rejects the upload.
      headers: { 'Content-Type': contentType },
      expiresIn: UPLOAD_TTL_SECONDS,
    };
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: Number(result.ContentLength ?? 0),
        contentType: result.ContentType ?? 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  async publicUrl(key: string): Promise<string> {
    // A CDN in front of the bucket is the normal production setup (§4.5), and
    // signing is pointless once the object is public through it.
    if (this.cdnBase) return `${this.cdnBase.replace(/\/$/, '')}/${key}`;

    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: 3600,
    });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * Lists and deletes in pages of 1000 — the limit both `ListObjectsV2` and
   * `DeleteObjects` impose. A site with more objects than that is normal, so
   * the loop is the point, not an edge case.
   */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;

    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      const keys = (listed.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => Boolean(key));

      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += keys.length;
      }

      // Deleting as we go invalidates nothing: the token refers to the listing
      // position, and re-listing a prefix we have emptied simply returns less.
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    return deleted;
  }

  async read(key: string): Promise<Readable> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return result.Body as Readable;
  }
}

// ---------------------------------------------------------------------------

/**
 * Development driver: objects live under `MEDIA_ROOT` and the "presigned" URL
 * is an HMAC-signed route on this API.
 *
 * The signature covers the key, the content type and an expiry, so the upload
 * endpoint can stay unauthenticated — exactly like S3 — without becoming an
 * open write endpoint.
 */
class LocalDiskDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;
  private readonly apiUrl: string;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get<string>('MEDIA_ROOT') ?? '.media');
    this.apiUrl = (config.get<string>('API_URL') ?? 'http://localhost:4000').replace(/\/$/, '');
    this.secret = config.getOrThrow<string>('JWT_SECRET');
  }

  async presignUpload(key: string, contentType: string): Promise<PresignedUpload> {
    const expires = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    const signature = this.sign(key, contentType, expires);

    const query = new URLSearchParams({
      key,
      content_type: contentType,
      expires: String(expires),
      signature,
    });

    return {
      url: `${this.apiUrl}/uploads/local?${query.toString()}`,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresIn: UPLOAD_TTL_SECONDS,
    };
  }

  /** Verifies a signed upload request. Returns the key, or null if invalid. */
  verify(key: string, contentType: string, expires: number, signature: string): boolean {
    if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;

    const expected = this.sign(key, contentType, expires);
    // Length-safe comparison; both are hex digests of the same length.
    return expected.length === signature.length && expected === signature;
  }

  async write(key: string, stream: Readable): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await pipeline(stream, createWriteStream(path));
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const stats = await stat(this.pathFor(key));
      return { sizeBytes: stats.size, contentType: 'application/octet-stream' };
    } catch {
      return null;
    }
  }

  async publicUrl(key: string): Promise<string> {
    return `${this.apiUrl}/uploads/local/${key}`;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    // pathFor is still the traversal guard here: a prefix that escaped the root
    // would turn this into a recursive delete of arbitrary directories.
    const path = this.pathFor(prefix);

    let count = 0;
    try {
      const entries = await readdir(path, { recursive: true, withFileTypes: true });
      count = entries.filter((entry) => entry.isFile()).length;
    } catch {
      // Nothing was ever written under this prefix — the same no-op S3 gives.
      return 0;
    }

    await rm(path, { recursive: true, force: true });
    return count;
  }

  async read(key: string): Promise<Readable> {
    return createReadStream(this.pathFor(key));
  }

  private sign(key: string, contentType: string, expires: number): string {
    return createHmac('sha256', this.secret)
      .update(`${key}\n${contentType}\n${expires}`)
      .digest('hex');
  }

  /**
   * Resolves a storage key to a path, refusing anything that escapes the root.
   * Keys are generated server-side, but this is the last line before a
   * filesystem write — a traversal here would be an arbitrary file write.
   */
  private pathFor(key: string): string {
    const path = resolve(join(this.root, normalize(key)));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`Storage key escapes the media root: ${key}`);
    }
    return path;
  }
}

export { LocalDiskDriver };

/** Random component for keys, so an id alone does not let anyone guess a URL. */
export function randomSuffix(): string {
  return randomBytes(6).toString('hex');
}
