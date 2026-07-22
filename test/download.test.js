import test from 'node:test';
import assert from 'node:assert/strict';
import { videoResponseHeaders } from '../web/server.js';

test('download response has Telegram-required attachment and CORS headers', () => {
  const headers = videoResponseHeaders('UA 42/7', {
    'content-length': '12345',
    'content-range': 'bytes 0-99/12345',
  }, true);

  assert.equal(headers['content-type'], 'video/mp4');
  assert.equal(headers['content-disposition'], 'attachment; filename="UA_42_7.mp4"');
  assert.equal(headers['access-control-allow-origin'], 'https://web.telegram.org');
  assert.equal(headers['content-length'], '12345');
  assert.equal(headers['content-range'], 'bytes 0-99/12345');
});

test('preview response stays inline', () => {
  const headers = videoResponseHeaders('42', {}, false);

  assert.equal(headers['content-type'], 'video/mp4');
  assert.equal(headers['content-disposition'], undefined);
  assert.equal(headers['access-control-allow-origin'], undefined);
});
