import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import path from "path";
import fs from "fs";

// Локально .env лежить у корені репозиторію
const rootEnv = path.resolve(__dirname, "../../.env");
if (fs.existsSync(rootEnv)) {
  config({ path: rootEnv });
} else {
  config();
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "Відсутня змінна середовища DATABASE_URL. Додайте її у .env у корені репозиторію (див. .env.example)."
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
