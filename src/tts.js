// Українська озвучка через Microsoft Edge TTS (безкоштовно, без ключів).
// Потребує CLI edge-tts (pip install edge-tts) — крок закоментовано в check.yml.
// УВІМКНЕННЯ: розкоментувати крок встановлення і ENABLE_TTS: "1" у check.yml.
import { execFile } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';

const VOICE = process.env.TTS_VOICE || 'uk-UA-OstapNeural'; // жіночий: uk-UA-PolinaNeural

export async function synthesizeVoiceover(text, outputPath, { rate = '+15%' } = {}) {
  const textFile = `${outputPath}.txt`;
  await writeFile(textFile, text);
  const args = ['--voice', VOICE, `--rate=${rate}`, '--file', textFile, '--write-media', outputPath];
  // Edge TTS ігнорує HTTPS_PROXY з оточення — передаємо явно, якщо задано.
  if (process.env.HTTPS_PROXY) args.unshift('--proxy', process.env.HTTPS_PROXY);
  try {
    await new Promise((resolve, reject) => {
      execFile('edge-tts', args, { maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) {
          error.message = `edge-tts: ${error.message.split('\n')[0]}`;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve();
        }
      });
    });
  } finally {
    await unlink(textFile).catch(() => {});
  }
  return outputPath;
}
