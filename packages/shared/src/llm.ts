import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "./env";
import { CLAUDE_MODEL, SYSTEM_PROMPT } from "./prompts";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return _client;
}

/**
 * Запит до Claude зі structured outputs (json_schema) — модель повертає
 * гарантовано валідний JSON за схемою.
 */
export async function askClaudeJSON<T>(
  prompt: string,
  schema: Record<string, unknown>
): Promise<T> {
  const client = getClient();
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema },
    },
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude відхилив запит (refusal). Спробуйте переформулювати.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Відповідь Claude обірвалася через ліміт токенів (max_tokens).");
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude не повернув текстової відповіді.");
  }
  return JSON.parse(textBlock.text) as T;
}
