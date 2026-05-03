import "server-only";

/**
 * Server-only env access.
 * Throws on missing required vars so routes fail fast with a clear message
 * instead of silently 500ing on the provider call.
 */

export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

export const ServerEnv = {
  livekit: () => ({
    url: requireEnv("LIVEKIT_URL"),
    apiKey: requireEnv("LIVEKIT_API_KEY"),
    apiSecret: requireEnv("LIVEKIT_API_SECRET"),
  }),
  openrouter: () => ({
    managementKey: requireEnv("OPENROUTER_MANAGEMENT_API_KEY"),
    appUrl: process.env.OPENROUTER_APP_URL?.trim() || "http://localhost:3020",
    appName: process.env.OPENROUTER_APP_NAME?.trim() || "SignChat Workbench",
  }),
  elevenlabs: () => ({
    apiKey: requireEnv("ELEVENLABS_API_KEY"),
    defaultVoiceId: requireEnv("ELEVENLABS_VOICE_ID"),
  }),
};
