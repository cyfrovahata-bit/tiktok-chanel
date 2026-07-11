// Локально підтягуємо .env з кореня монорепо (на Railway змінні приходять із сервісу)
const path = require("path");
const fs = require("fs");
const rootEnv = path.resolve(__dirname, "../../.env");
if (fs.existsSync(rootEnv)) {
  require("dotenv").config({ path: rootEnv });
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: path.resolve(__dirname, "../.."),
};

module.exports = nextConfig;
