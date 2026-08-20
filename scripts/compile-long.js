// CLI-обгортка навколо src/compile-long.js.
//
//   node scripts/compile-long.js --limit 3
//   node scripts/compile-long.js --ids AUTO-20260816-1203,AUTO-20260817-0910
//   node scripts/compile-long.js --limit 10 --wide      (16:9 для YouTube)
//   node scripts/compile-long.js --limit 3 --keep-cta   (не різати хвости)
//   node scripts/compile-long.js --limit 3 --rebuild    (перезібрати з озвучкою наново)
//   node scripts/compile-long.js --limit 3 --no-separators  (без роздільників)
//   node scripts/compile-long.js --limit 3 --no-intro       (без вступної заставки)
//
// Результат лишається локальним файлом: на Drive нічого не заливається,
// щоб пробну збірку можна було спершу подивитися.
import { readAllItems } from '../src/sheets.js';
import { compileLong } from '../src/compile-long.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

async function pickItems() {
  const items = await readAllItems();
  const usable = items.filter((it) => it.archive && it.title);
  const ids = arg('ids');
  if (ids) {
    return ids.split(',').map((s) => s.trim()).filter(Boolean).map((id) => {
      const item = usable.find((it) => it.id === id);
      if (!item) throw new Error(`Рядка ${id} немає або в ньому порожній архів чи назва.`);
      return item;
    });
  }
  const limit = Number(arg('limit', '3'));
  const published = usable.filter((it) => it.status === 'PUBLISHED');
  const pool = published.length >= limit ? published : usable;
  return pool.slice(-limit);
}

async function main() {
  const items = await pickItems();
  console.log(`Беру ${items.length} епізод(и):`);
  items.forEach((it, i) => console.log(`  ${i + 1}. ${it.id} — ${it.title}`));

  const result = await compileLong(items, {
    wide: flag('wide'),
    keepCta: flag('keep-cta'),
    reuseVideo: !flag('rebuild'),
    separators: !flag('no-separators'),
    intro: !flag('no-intro'),
    onProgress: (text) => console.log(`  ${text}`),
  });

  console.log(`\nГотово: ${result.path}`);
  console.log(`Розмір: ${(result.size / 1024 / 1024).toFixed(1)} МБ, епізодів: ${result.episodes}`);
}

main().catch((error) => {
  console.error(`\nПомилка: ${error.message}`);
  process.exit(1);
});
