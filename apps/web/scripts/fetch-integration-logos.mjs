// Fetch + normalise integration brand SVGs.
//
// We download from Wikimedia Commons because:
//  - Per-vendor brand-page scraping (Zoom, Teams, Meet, Slack, Discord,
//    Webex) requires hand-tuned selectors and breaks on every redesign.
//  - Wikimedia Commons hosts the official-source SVGs at stable URLs and
//    is unauthenticated. The brand owners retain the trademarks; we use
//    the marks under nominative-fair-use to indicate genuine integrations.
//
// Output: public/integrations/{slug}.svg + manifest.json (sources, license).
//
// Run:   node scripts/fetch-integration-logos.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public", "integrations");
const PROVIDERS_DIR = path.join(ROOT, "public", "providers");
const SI_DIR = path.join(ROOT, "node_modules", "simple-icons", "icons");

/** AI/ML provider chain — sourced from the `simple-icons` package (CC0).
 * each represents a real component of the Signchat pipeline (architecture
 * §1, §3) so they belong in the agent rail. */
const PROVIDERS = [
  { slug: "onnx",       file: "onnx.svg",         vendor: "ONNX Runtime" },
  { slug: "mediapipe",  file: "mediapipe.svg",    vendor: "MediaPipe" },
  { slug: "gemini",     file: "googlegemini.svg", vendor: "Google Gemini" },
  { slug: "elevenlabs", file: "elevenlabs.svg",   vendor: "ElevenLabs" },
  { slug: "livekit",    file: "livekit.svg",      vendor: "LiveKit" },
];

/** vendor → wikimedia commons direct svg url. */
const SOURCES = [
  {
    slug: "zoom",
    vendor: "Zoom",
    url: "https://upload.wikimedia.org/wikipedia/commons/7/7b/Zoom_Communications_Logo.svg",
  },
  {
    slug: "teams",
    vendor: "Microsoft Teams",
    url: "https://upload.wikimedia.org/wikipedia/commons/0/07/Microsoft_Office_Teams_%282025%E2%80%93present%29.svg",
  },
  {
    slug: "meet",
    vendor: "Google Meet",
    url: "https://upload.wikimedia.org/wikipedia/commons/9/9b/Google_Meet_icon_%282020%29.svg",
  },
  {
    slug: "slack",
    vendor: "Slack",
    url: "https://upload.wikimedia.org/wikipedia/commons/d/d5/Slack_icon_2019.svg",
  },
  {
    slug: "discord",
    vendor: "Discord",
    url: "https://upload.wikimedia.org/wikipedia/en/9/98/Discord_logo.svg",
  },
  {
    slug: "webex",
    vendor: "Webex",
    url: "https://upload.wikimedia.org/wikipedia/commons/f/f9/Cisco_Webex_logo_-_Brandlogos.net.svg",
  },
];

/** strip <?xml?>, <!DOCTYPE>, comments; if no viewBox is set, derive one
 * from width/height; then strip width/height so the svg scales to the
 * wrapping element. brand colors are preserved untouched. */
function normalise(raw) {
  let s = raw.trim();
  s = s.replace(/<\?xml[^?]*\?>\s*/i, "");
  s = s.replace(/<!DOCTYPE[^>]*>\s*/i, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  // capture the outer <svg ...> tag to operate on its attribute set.
  const svgOpenMatch = s.match(/<svg\b[^>]*>/i);
  if (svgOpenMatch) {
    let openTag = svgOpenMatch[0];
    const hasViewBox = /\bviewBox=/i.test(openTag);
    if (!hasViewBox) {
      const w = (openTag.match(/\bwidth="([^"]+)"/i) || [])[1];
      const h = (openTag.match(/\bheight="([^"]+)"/i) || [])[1];
      const wn = w ? parseFloat(w) : NaN;
      const hn = h ? parseFloat(h) : NaN;
      if (Number.isFinite(wn) && Number.isFinite(hn) && wn > 0 && hn > 0) {
        openTag = openTag.replace(/<svg\b/i, `<svg viewBox="0 0 ${wn} ${hn}"`);
      }
    }
    // now strip width/height from the open tag so the consumer sizes it.
    openTag = openTag.replace(/\s+width="[^"]*"/i, "");
    openTag = openTag.replace(/\s+height="[^"]*"/i, "");
    if (!/xmlns=/.test(openTag)) {
      openTag = openTag.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    s = s.replace(svgOpenMatch[0], openTag);
  }

  return s.trim();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fetchSvg(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "SignchatLogoFetcher/1.0 (+https://signchat.example/integrations)",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} ${url}`);
  }
  return res.text();
}

async function main() {
  await ensureDir(PUBLIC_DIR);
  await ensureDir(PROVIDERS_DIR);

  const manifest = {
    generated: new Date().toISOString(),
    notes: [
      "Logos used under nominative-fair-use to indicate genuine integrations.",
      "Integration logos sourced from Wikimedia Commons; provider logos from the `simple-icons` package (CC0).",
      "Brand owners retain trademark; Signchat displays these marks only to indicate real integration / provider support.",
    ],
    integrations: [],
    providers: [],
  };

  for (const { slug, vendor, url } of SOURCES) {
    const raw = await fetchSvg(url);
    const out = normalise(raw);
    const dest = path.join(PUBLIC_DIR, `${slug}.svg`);
    await fs.writeFile(dest, out + "\n", "utf8");
    manifest.integrations.push({
      slug,
      vendor,
      file: `public/integrations/${slug}.svg`,
      source: url,
      license: "Brand owner trademark; mark used under nominative fair use",
    });
    console.log(`  ✓ ${slug.padEnd(10)} ← ${url}`);
  }

  for (const { slug, file, vendor } of PROVIDERS) {
    const src = path.join(SI_DIR, file);
    const raw = await fs.readFile(src, "utf8");
    const out = normalise(raw);
    const dest = path.join(PROVIDERS_DIR, `${slug}.svg`);
    await fs.writeFile(dest, out + "\n", "utf8");
    manifest.providers.push({
      slug,
      vendor,
      file: `public/providers/${slug}.svg`,
      source: "simple-icons npm",
      license: "CC0-1.0 (icon data) — vendor retains trademark",
    });
    console.log(`  ✓ ${slug.padEnd(10)} ← simple-icons/${file}`);
  }

  await fs.writeFile(
    path.join(PUBLIC_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );

  console.log(
    `\nwrote ${manifest.integrations.length} integration svgs, ${manifest.providers.length} provider svgs + manifest.json`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
