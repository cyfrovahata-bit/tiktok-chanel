import { config } from "dotenv";
import path from "path";
import fs from "fs";

// Локально .env лежить у корені монорепо; на Railway змінні приходять із сервісу.
const rootEnv = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(rootEnv)) {
  config({ path: rootEnv });
} else {
  config();
}
