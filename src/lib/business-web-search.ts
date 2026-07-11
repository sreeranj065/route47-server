/**
 * Multi-engine business discovery search (web → geocode hints).
 * Provider-agnostic: Serper (Google) when ROUTE47_SERPER_API_KEY is set,
 * otherwise DuckDuckGo HTML + Bing HTML.
 */

export interface BusinessWebHint {
  title: string;
  snippet: string;
  geocodeQuery: string;
  source: string;
  confidence: number;
}

export interface BusinessSearchResult {
  title: string;
  subtitle: string;
  lat: number;
  lng: number;
  confidence: number;
  source: string;
}

const USER_AGENT = "Route47CustomerServer/1.0 (+https://route47.app)";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const FETCH_TIMEOUT_MS = 8_000;

const ADDRESS_PATTERN =
  /\b\d{1,6}\s+[A-Za-z][\w.'#-]*(?:[\s,]+[A-Za-z0-9][\w.'#-]*)*(?:,\s*[A-Za-z][\w.'#-]*(?:[\s,]+[A-Za-z0-9][\w.'#-]*)*){0,3}/;

const BUSINESS_SUFFIX_WORDS = new Set([
  "corporation", "corp", "incorporated", "inc", "limited", "ltd", "company", "co",
  "llc", "lp", "llp", "plc", "gmbh", "flooring", "materials", "services", "service",
]);

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeFuzzy(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[''`".]/g, "")
    .replace(/[-–—_/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function businessTokens(query: string): string[] {
  return normalizeFuzzy(query)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !BUSINESS_SUFFIX_WORDS.has(token));
}

function hintConfidence(query: string, title: string, snippet: string): number {
  const haystack = normalizeFuzzy(`${title} ${snippet}`);
  let score = 0;
  for (const token of businessTokens(query)) {
    if (haystack.includes(token)) score += 18;
  }
  const normalizedQuery = normalizeFuzzy(query);
  const normalizedTitle = normalizeFuzzy(title);
  if (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle)) {
    score += 24;
  }
  return score;
}

function extractAddress(text: string): string {
  const match = text.match(ADDRESS_PATTERN);
  return match?.[0]?.trim() ?? "";
}

function extractLocationFromTitle(title: string): string {
  const parts = title
    .split(/\s[-–|]\s/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (last.length >= 3 && last.length <= 48 && !/^\d/.test(last)) return last;
  }
  return "";
}

export function buildGeocodeQueryFromHint(
  title: string,
  snippet: string,
  countryName?: string,
): string {
  const cleanTitle = stripHtml(title);
  const cleanSnippet = stripHtml(snippet);
  const address = extractAddress(cleanSnippet) || extractAddress(cleanTitle);
  if (address) {
    return countryName ? `${address}, ${countryName}` : address;
  }

  const businessName = cleanTitle.split(/\s[-–|]\s/)[0]?.trim() || cleanTitle;
  const location = extractLocationFromTitle(cleanTitle);
  const parts = [businessName, location, countryName].filter(Boolean);
  return parts.join(", ");
}

export function buildWebSearchQueries(query: string, countryName?: string): string[] {
  const trimmed = query.trim();
  const variants = new Set<string>();
  const add = (value: string) => {
    const cleaned = value.trim().replace(/\s+/g, " ");
    if (cleaned.length >= 3) variants.add(cleaned);
  };

  add(trimmed);
  if (countryName) {
    add(`${trimmed} ${countryName}`);
    add(`"${trimmed}" business address ${countryName}`);
    add(`${trimmed} store location ${countryName}`);
  } else {
    add(`"${trimmed}" business address`);
  }

  const normalized = normalizeFuzzy(trimmed);
  const compact = normalized.replace(/\s+/g, "");
  if (compact.length >= 3 && compact.length <= 20) {
    const match = compact.match(/^([a-z])([a-z])(.*)$/);
    if (match) {
      const [, first, second, rest] = match;
      add(`${first}&${second}${rest ? ` ${rest}` : ""}${countryName ? ` ${countryName}` : ""}`);
    }
  }

  return [...variants].slice(0, 4);
}

async function fetchText(url: string, init?: RequestInit): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseDuckDuckGoHtml(html: string, query: string, countryName?: string): BusinessWebHint[] {
  const hints: BusinessWebHint[] = [];
  const seen = new Set<string>();

  const blockRegex =
    /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(html)) !== null) {
    const title = stripHtml(match[1]);
    const snippet = stripHtml(match[2]);
    if (title.length < 3) continue;

    const geocodeQuery = buildGeocodeQueryFromHint(title, snippet, countryName);
    if (geocodeQuery.length < 4) continue;

    const key = geocodeQuery.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    hints.push({
      title,
      snippet,
      geocodeQuery,
      source: "duckduckgo",
      confidence: hintConfidence(query, title, snippet),
    });
  }

  return hints.sort((a, b) => b.confidence - a.confidence);
}

function parseBingHtml(html: string, query: string, countryName?: string): BusinessWebHint[] {
  const hints: BusinessWebHint[] = [];
  const seen = new Set<string>();
  const blockRegex = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p class="b_lineclamp2">([\s\S]*?)<\/p>/gi;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(html)) !== null) {
    const title = stripHtml(match[1]);
    const snippet = stripHtml(match[2]);
    if (title.length < 3) continue;

    const geocodeQuery = buildGeocodeQueryFromHint(title, snippet, countryName);
    if (geocodeQuery.length < 4) continue;

    const key = geocodeQuery.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    hints.push({
      title,
      snippet,
      geocodeQuery,
      source: "bing",
      confidence: hintConfidence(query, title, snippet),
    });
  }

  return hints.sort((a, b) => b.confidence - a.confidence);
}

async function searchDuckDuckGo(query: string, countryName?: string): Promise<BusinessWebHint[]> {
  const params = new URLSearchParams({ q: query, kl: "us-en" });
  const html = await fetchText(`https://html.duckduckgo.com/html/?${params}`);
  if (!html) return [];
  return parseDuckDuckGoHtml(html, query, countryName);
}

async function searchBing(query: string, countryName?: string): Promise<BusinessWebHint[]> {
  const params = new URLSearchParams({ q: query, setlang: "en-US" });
  const html = await fetchText(`https://www.bing.com/search?${params}`);
  if (!html) return [];
  return parseBingHtml(html, query, countryName);
}

async function searchSerper(query: string, countryCode?: string): Promise<BusinessWebHint[]> {
  const apiKey = process.env.ROUTE47_SERPER_API_KEY?.trim();
  if (!apiKey) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        gl: (countryCode ?? "us").toLowerCase(),
        num: 8,
      }),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      organic?: Array<{ title?: string; snippet?: string; address?: string }>;
    };

    return (data.organic ?? [])
      .map((item) => {
        const title = item.title?.trim() ?? "";
        const snippet = [item.snippet, item.address].filter(Boolean).join(" — ");
        const geocodeQuery = buildGeocodeQueryFromHint(title, snippet);
        if (!title || geocodeQuery.length < 4) return null;
        return {
          title,
          snippet,
          geocodeQuery,
          source: "google-serper",
          confidence: hintConfidence(query, title, snippet) + 12,
        } satisfies BusinessWebHint;
      })
      .filter((hint): hint is BusinessWebHint => hint !== null);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverBusinessWebHints(
  query: string,
  options: { countryName?: string; countryCode?: string; limit?: number } = {},
): Promise<BusinessWebHint[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const searchQueries = buildWebSearchQueries(trimmed, options.countryName);
  const merged = new Map<string, BusinessWebHint>();

  for (const searchQuery of searchQueries) {
    const [serper, ddg, bing] = await Promise.all([
      searchSerper(searchQuery, options.countryCode),
      searchDuckDuckGo(searchQuery, options.countryName),
      searchBing(searchQuery, options.countryName),
    ]);

    for (const hint of [...serper, ...ddg, ...bing]) {
      const key = hint.geocodeQuery.toLowerCase();
      const existing = merged.get(key);
      if (!existing || hint.confidence > existing.confidence) {
        merged.set(key, hint);
      }
    }

    if (merged.size >= (options.limit ?? 8)) break;
  }

  return [...merged.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, options.limit ?? 8);
}

async function geocodeHint(hint: BusinessWebHint, countryCode?: string): Promise<BusinessSearchResult | null> {
  const params = new URLSearchParams({
    q: hint.geocodeQuery,
    format: "jsonv2",
    addressdetails: "1",
    limit: "1",
  });
  if (countryCode && countryCode.length === 2) {
    params.set("countrycodes", countryCode.toLowerCase());
  }

  const text = await fetchText(`${NOMINATIM_BASE}/search?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!text) return null;

  try {
    const items = JSON.parse(text) as Array<{
      lat?: string;
      lon?: string;
      display_name?: string;
      address?: Record<string, string | undefined>;
    }>;
    const item = items[0];
    if (!item?.lat || !item?.lon) return null;

    const address = item.address ?? {};
    const subtitle =
      item.display_name ??
      [
        [address.house_number, address.road].filter(Boolean).join(" "),
        address.city || address.town || address.village,
        address.state,
        address.country,
      ]
        .filter(Boolean)
        .join(", ");

    return {
      title: hint.title.split(/\s[-–|]\s/)[0]?.trim() || hint.title,
      subtitle,
      lat: Number(item.lat),
      lng: Number(item.lon),
      confidence: hint.confidence,
      source: `${hint.source}+nominatim`,
    };
  } catch {
    return null;
  }
}

export async function searchBusinessLocations(
  query: string,
  options: { countryName?: string; countryCode?: string; limit?: number } = {},
): Promise<BusinessSearchResult[]> {
  const hints = await discoverBusinessWebHints(query, options);
  if (hints.length === 0) return [];

  const results: BusinessSearchResult[] = [];
  const seen = new Set<string>();

  const geocoded = await Promise.all(
    hints.slice(0, 6).map((hint) => geocodeHint(hint, options.countryCode)),
  );

  for (const item of geocoded) {
    if (!item || !Number.isFinite(item.lat) || !Number.isFinite(item.lng)) continue;
    const key = `${item.lat.toFixed(5)}_${item.lng.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(item);
  }

  return results
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, options.limit ?? 8);
}
