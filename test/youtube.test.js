import test from 'node:test';
import assert from 'node:assert/strict';
import { publishYouTubeShort } from '../src/youtube.js';

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

test('YouTube: назва й опис із #Shorts, теги порожні, ШІ-позначка є', async () => {
  const client = fakeClient();
  const result = await publishYouTubeShort(short, { client });

  const body = client.calls[0].requestBody;
  assert.equal(body.snippet.title, 'Соледар #Shorts');
  assert.equal(body.snippet.description, 'Опис #Соледар #ЧиВиЗнали #Shorts');
  assert.equal(body.snippet.tags, undefined, 'теги навмисно не заповнюємо');
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

test('YouTube: довга назва ріжеться так, щоб #Shorts лишився цілим', async () => {
  const client = fakeClient();
  await publishYouTubeShort({ ...short, title: 'я'.repeat(140) }, { client });
  const title = client.calls[0].requestBody.snippet.title;
  assert.equal(title.length, 100, 'рівно ліміт YouTube');
  assert.ok(title.endsWith(' #Shorts'), 'хештег не обрізається');
  assert.ok(title.includes('…'), 'обрізали саме назву');
});

test('YouTube: порожній файл не заливається', async () => {
  await assert.rejects(
    publishYouTubeShort({ ...short, videoBuffer: Buffer.alloc(0) }, { client: fakeClient() }),
    /порожній файл/,
  );
});

test('YOUTUBE_SHORTS_TAG=0 лишає назву без хештега', async () => {
  const client = fakeClient();
  const previous = process.env.YOUTUBE_SHORTS_TAG;
  process.env.YOUTUBE_SHORTS_TAG = '0';
  try {
    await publishYouTubeShort(short, { client });
  } finally {
    if (previous === undefined) delete process.env.YOUTUBE_SHORTS_TAG;
    else process.env.YOUTUBE_SHORTS_TAG = previous;
  }
  assert.equal(client.calls[0].requestBody.snippet.title, 'Соледар');
  assert.equal(client.calls[0].requestBody.snippet.description, 'Опис #Соледар #ЧиВиЗнали');
});

test('YouTube: #Shorts у назві не дублюється', async () => {
  const client = fakeClient();
  await publishYouTubeShort({ ...short, title: 'Соледар #shorts' }, { client });
  assert.equal(client.calls[0].requestBody.snippet.title, 'Соледар #shorts');
});


import { longTitle } from '../src/youtube.js';

test('назва довгого відео йде без #Shorts', () => {
  // Вертикальне відео на 13 хвилин Shorts'ом не стане, і хештег лише
  // обіцяє глядачеві не те.
  assert.equal(longTitle('5 замків України #Shorts'), '5 замків України');
  assert.equal(longTitle('Замок, якого не було'), 'Замок, якого не було');
});

test('задовга назва довгого відео ріжеться під межу YouTube', () => {
  const out = longTitle('я'.repeat(180));
  assert.ok(out.length <= 100, `вийшло ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('порожня назва — це помилка, а не тихе відео без назви', () => {
  assert.throws(() => longTitle('   '), /порожня назва/);
});
