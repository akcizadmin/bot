import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5';

let client: Anthropic | null = null;

export function agentsEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * One-shot text generation. Server-side fallback is enabled so a rare safety
 * false-positive re-runs on Anthropic's recommended fallback model instead of
 * failing the brief.
 */
export async function generate(system: string, user: string, maxTokens = 2048): Promise<string> {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('model declined the request');
  }
  return response.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
