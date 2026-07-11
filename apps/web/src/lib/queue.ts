import { Queue } from "bullmq";
import { RENDER_QUEUE, redisConnectionOptions } from "@shorts/shared";

let _queue: Queue | null = null;

/** Черга рендеру BullMQ (лінива ініціалізація, щоб build не вимагав REDIS_URL). */
export function getRenderQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(RENDER_QUEUE, { connection: redisConnectionOptions() });
  }
  return _queue;
}
