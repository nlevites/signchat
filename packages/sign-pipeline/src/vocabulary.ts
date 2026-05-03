export async function loadVocabulary(
  url: string = "/models/asl-signs/labels.json",
): Promise<string[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`vocabulary fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data) || !data.every((x) => typeof x === "string")) {
    throw new Error("vocabulary response was not a string[]");
  }
  return data;
}
