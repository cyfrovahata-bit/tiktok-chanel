import { requireEnv } from "./env";

/**
 * Опції підключення Redis для BullMQ з REDIS_URL.
 * Передаємо опції (а не інстанс ioredis), щоб уникнути конфлікту версій типів.
 */
export function redisConnectionOptions(): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
} {
  const url = new URL(requireEnv("REDIS_URL"));
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
