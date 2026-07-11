import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { requireEnv } from "./env";

let _client: S3Client | null = null;

/** S3-клієнт для Cloudflare R2 (S3-сумісний API). */
export function getR2(): S3Client {
  if (!_client) {
    const accountId = requireEnv("R2_ACCOUNT_ID");
    _client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return _client;
}

export function r2Bucket(): string {
  return requireEnv("R2_BUCKET");
}

/** Завантажити обʼєкт у R2. */
export async function r2Put(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  await getR2().send(
    new PutObjectCommand({
      Bucket: r2Bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/** Завантажити обʼєкт з R2 у Buffer. */
export async function r2Get(key: string): Promise<Buffer> {
  const res = await getR2().send(
    new GetObjectCommand({ Bucket: r2Bucket(), Key: key })
  );
  if (!res.Body) {
    throw new Error(`Обʼєкт ${key} у R2 порожній або не існує.`);
  }
  const stream = res.Body as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Тимчасове підписане посилання на обʼєкт (для прев'ю у браузері). */
export async function r2SignedUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  return getSignedUrl(
    getR2(),
    new GetObjectCommand({ Bucket: r2Bucket(), Key: key }),
    { expiresIn: expiresInSeconds }
  );
}
