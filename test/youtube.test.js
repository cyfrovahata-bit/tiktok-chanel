import test from 'node:test';
import assert from 'node:assert/strict';
import { publishYouTubeShort, tagsFromDescription } from '../src/youtube.js';

// Підроблений клієнт googleapis: запам'ятовує запит і віддає задану відповідь.
function fakeClient(responseStatus = { privacyStatus: 'public', uploadStatus: 'uploaded' }) {
  const calls = [];
  return {
    calls,
    videos: {
      insert: async (params) => {
        calls.push(params);
        return { data: { id: 'yt-1', status: responseStatus } };
      },
    },
  };
}

const short = { videoBuffer: Buffer.from('mp4'), title: 'Соледар', description: 'Опис #Соледар #ЧиВиЗнали' };

test('YouTube: надсилає назву, опис, теги і ШІ-позначку', async () => {
  const client = fakeClient();
  const result = await publishYouTubeShort(short, { client });

  const body = client.calls[0].requestBody;
  assert.equal(body.snippet.title, 'Соледар');
  assert.equal(body.snippet.description, 'Опис #Соледар #ЧиВиЗнали');
  assert.deepEqual(body.snippet.tags, ['Соледар', 'ЧиВиЗнали']);
  assert.equal(body.status.containsSyntheticMedia, true);
  assert.equal(body.status.selfDeclaredMadeForKids, false);
  assert.deepEqual(client.calls[0].part, ['snippet', 'status']);
  assert.equal(result.id, 'yt-1');
  assert.equal(result.forcedPrivate, false);
});

test('YouTube: приватність беремо з відповіді, а не з запиту', async () => {
  // Проєкт без аудиту: просили public, YouTube мовчки поставив private.
  const client = fakeClient({ privacyStatus: 'private', uploadStatus: 'uploaded' });
  const result = await publishYouTubeShort(short, { client });

  assert.equal(client.calls[0].requestBody.status.privacyStatus, 'public');
  assert.equal(result.privacyStatus, 'private');
  assert.equal(result.forcedPrivate, true, 'треба помітити підміну публічного на приватне');
});

test('YOUTUBE_AI_LABEL=0 знімає позначку явно', async () => {
  const client = fakeClient();
  const previous = process.env.YOUTUBE_AI_LABEL;
  process.env.YOUTUBE_AI_LABEL = '0';
  try {
    await publishYouTubeShort(short, { client });
  } finally {
    if (previous === undefined) delete process.env.YOUTUBE_AI_LABEL;
    else process.env.YOUTUBE_AI_LABEL = previous;
  }
  assert.equal(client.calls[0].requestBody.status.containsSyntheticMedia, false);
});

test('YouTube: назва довша за 100 символів обрізається', async () => {
  const client = fakeClient();
  await publishYouTubeShort({ ...short, title: 'я'.repeat(140) }, { client });
  const title = client.calls[0].requestBody.snippet.title;
  assert.equal(title.length, 100);
  assert.ok(title.endsWith('…'));
});

test('YouTube: порожній файл не заливається', async () => {
  await assert.rejects(
    publishYouTubeShort({ ...short, videoBuffer: Buffer.alloc(0) }, { client: fakeClient() }),
    /порожній файл/,
  );
});

test('теги з опису: без дублів і без «решітки»', () => {
  assert.deepEqual(
    tagsFromDescription('текст #Київ #Київ #Історія'),
    ['Київ', 'Історія'],
  );
  assert.deepEqual(tagsFromDescription(''), []);
});
