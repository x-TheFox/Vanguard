/**
 * Paste Link Extractor — Vanguard Detection Layer
 *
 * Fetches content from paste services (mclogs, pastebin, bytebin, etc.)
 * so Vanguard can pass the full crash log to Aegis for diagnosis.
 */

/** Supported paste service types */
type PasteService = 'mclogs' | 'pastebin' | 'gnome' | 'bytebin' | 'raw';

/** Identify which paste service a URL belongs to */
export function identifyPasteService(url: string): PasteService | null {
  if (/mclo\.gs|mclogs\.io/i.test(url)) return 'mclogs';
  if (/pastebin\.com/i.test(url)) return 'pastebin';
  if (/gnome\.dev/i.test(url)) return 'gnome';
  if (/bytebin\.lucko\.me/i.test(url)) return 'bytebin';
  return null;
}

/** Get the raw content URL from a paste service URL */
export function getRawContentUrl(url: string, service: PasteService): string {
  switch (service) {
    case 'mclogs': {
      // mclogs API: https://api.mclo.gs/1/log/<id>
      const match = url.match(/mclo\.gs\/(\w+)/i) ?? url.match(/mclogs\.io\/(\w+)/i);
      return match ? `https://api.mclo.gs/1/log/${match[1]}` : url;
    }
    case 'pastebin': {
      const match = url.match(/pastebin\.com\/(\w+)/i);
      return match ? `https://pastebin.com/raw/${match[1]}` : url;
    }
    case 'bytebin': {
      const match = url.match(/bytebin\.lucko\.me\/(\w+)/i);
      return match ? `https://bytebin.lucko.me/${match[1]}` : url;
    }
    default:
      return url;
  }
}

/** Fetch content from a paste URL */
export async function fetchPasteContent(url: string): Promise<string> {
  const service = identifyPasteService(url);
  if (!service) throw new Error(`Unsupported paste service: ${url}`);

  const rawUrl = getRawContentUrl(url, service);
  const response = await fetch(rawUrl);
  if (!response.ok) throw new Error(`Failed to fetch paste content: ${response.status}`);

  if (service === 'mclogs') {
    const data = await response.json() as { content?: string };
    return data.content ?? '';
  }
  return response.text();
}
