/**
 * Робота зі змінними середовища.
 * ПРАВИЛО ПРОЄКТУ: жодних вигаданих ключів чи заглушок — якщо змінної нема,
 * кидаємо помилку з її назвою, щоб одразу було видно, що саме треба додати.
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Відсутня змінна середовища ${name}. Додайте її у .env (див. .env.example, там написано, де взяти ключ).`
    );
  }
  return value.trim();
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}
