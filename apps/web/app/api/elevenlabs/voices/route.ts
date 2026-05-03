import type {
  ElevenLabsVoiceSummary,
  ListElevenLabsVoicesResponse,
} from "@signchat/contracts";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { respondError } from "@/lib/api/sanitize";

export const dynamic = "force-dynamic";

const ELEVENLABS_VOICES_URL =
  "https://api.elevenlabs.io/v2/voices?page_size=100";

// Voice library rarely changes; a short module-level cache prevents
// re-hitting upstream every time the picker mounts (Lobby + Settings) and
// dampens accidental fan-out across multiple clients sharing this server.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { at: number; payload: ListElevenLabsVoicesResponse } | null = null;

interface UpstreamLabels {
  accent?: string;
  age?: string;
  gender?: string;
  description?: string;
  descriptive?: string;
  use_case?: string;
}

interface UpstreamVoice {
  voice_id?: string;
  name?: string;
  category?: string;
  description?: string;
  preview_url?: string;
  labels?: UpstreamLabels;
}

interface UpstreamPayload {
  voices?: UpstreamVoice[];
}

function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

function normalizeVoice(raw: UpstreamVoice): ElevenLabsVoiceSummary | null {
  if (!raw.voice_id || !raw.name) return null;
  const labels = raw.labels;
  // ElevenLabs returns either `description` or `descriptive` as the
  // "tone/personality" label depending on voice generation; coalesce.
  const descriptive = labels?.descriptive ?? labels?.description;
  const summary: ElevenLabsVoiceSummary = {
    voiceId: raw.voice_id,
    name: raw.name,
    category: raw.category ?? "other",
  };
  if (raw.description) summary.description = raw.description;
  if (raw.preview_url) summary.previewUrl = raw.preview_url;
  if (labels) {
    const out: NonNullable<ElevenLabsVoiceSummary["labels"]> = {};
    if (labels.gender) out.gender = labels.gender;
    if (labels.accent) out.accent = labels.accent;
    if (labels.age) out.age = labels.age;
    if (descriptive) out.descriptive = descriptive;
    if (Object.keys(out).length > 0) summary.labels = out;
  }
  return summary;
}

export async function GET(req: Request): Promise<Response> {
  try {
    enforceRateLimit(getClientIp(req), "voices");

    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS) {
      return Response.json(cached.payload);
    }

    const apiKey = readEnv("ELEVENLABS_API_KEY");
    const defaultVoiceId = readEnv("ELEVENLABS_VOICE_ID");

    const upstream = await fetch(ELEVENLABS_VOICES_URL, {
      method: "GET",
      headers: { "xi-api-key": apiKey },
      cache: "no-store",
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      console.error(
        "elevenlabs voices fetch failed",
        upstream.status,
        text.replace(/\s+/g, " ").slice(0, 200),
      );
      throw new Error("elevenlabs_voices_failed");
    }

    const data = (await upstream.json()) as UpstreamPayload;
    const rawVoices = data.voices ?? [];
    const voices: ElevenLabsVoiceSummary[] = [];
    for (const v of rawVoices) {
      const normalized = normalizeVoice(v);
      if (normalized) voices.push(normalized);
    }

    const payload: ListElevenLabsVoicesResponse = {
      voices,
      defaultVoiceId,
    };
    cached = { at: now, payload };

    console.log("listed elevenlabs voices", {
      count: voices.length,
      defaultVoiceId,
    });

    return Response.json(payload);
  } catch (err) {
    return respondError(err);
  }
}
