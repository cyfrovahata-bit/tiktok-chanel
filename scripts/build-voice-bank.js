// Разова генерація голосового банку: вступ на кожну кількість фактів і
// оголошення «Факт перший»… «Факт двадцятий».
//
//   node scripts/build-voice-bank.js          # до 20 фактів
//   node scripts/build-voice-bank.js 30       # до 30
//   node scripts/build-voice-bank.js 20 --force   # перезаписати вже наявні
//
// Файли лягають в assets/voice/ — після прогону їх треба закомітити: тоді
// збірка на Railway бере готовий голос і не витрачає ані символа ElevenLabs.
// Якщо задано VIDEO_FOLDER_ID (або VOICE_FOLDER_ID), кожна репліка одночасно
// вивантажується на Drive — на випадок, коли банк генерували не локально.
import { rm } from 'node:fs/promises';
import { bankPlan, bankDir, clipPath, hasClip, voiceClip, removeFromDrive } from '../src/voice-bank.js';

const maxFacts = Number(process.argv.find((a) => /^\d+$/.test(a))) || 20;
const force = process.argv.includes('--force');

async function main() {
  const plan = bankPlan({ maxFacts });
  console.log(`Банк на ${maxFacts} фактів: ${plan.length} реплік у ${bankDir()}`);

  let made = 0;
  let kept = 0;
  for (const { key, text } of plan) {
    if (force) {
      await rm(clipPath(key), { force: true });
      // Без цього щойно видалений файл просто повернувся б із Drive.
      await removeFromDrive(key).catch(() => {});
    } else if (await hasClip(key)) { kept++; continue; }
    process.stdout.write(`  ${key}: «${text}» … `);
    await voiceClip(key, text, { onProgress: () => {} });
    console.log('готово');
    made++;
  }

  console.log(`\nНово синтезовано: ${made}, вже було: ${kept}.`);
  if (made) console.log('Не забудь закомітити assets/voice — інакше наступний деплой синтезуватиме заново.');
}

main().catch((error) => {
  console.error(`\nПомилка: ${error.message}`);
  process.exit(1);
});
