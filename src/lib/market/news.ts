/**
 * Layer 1: headlines from free RSS feeds (Yahoo Finance, then Google News as a fallback).
 * Headlines are unverified third-party text: the app shows them with source and time,
 * and never treats a headline as evidence for a decision on its own.
 */
export type Headline = { title: string; url: string; publisher: string | null; publishedAt: string | null; feed: "yahoo" | "google" };
export type NewsResult = { symbol: string; headlines: Headline[]; feed: string; fetchedAt: string };

const UA = "Mozilla/5.0 (compatible; PortfolioIntelligence/1.0)";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : null;
}

const safeUrl = (u: string | null) => (u && /^https?:\/\//i.test(u) ? u : null);

/** Parses RSS 2.0 <item>s. Google titles end in " - Publisher"; that suffix becomes the publisher. */
export function parseRss(xml: string, feed: Headline["feed"], limit = 10): Headline[] {
  const out: Headline[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = m[1];
    let title = tag(item, "title");
    const url = safeUrl(tag(item, "link"));
    if (!title || !url) continue;
    let publisher = tag(item, "source");
    if (feed === "google" && !publisher) {
      const i = title.lastIndexOf(" - ");
      if (i > 0) publisher = title.slice(i + 3);
    }
    if (feed === "google" && publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3));
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const d = tag(item, "pubDate");
    const t = d ? new Date(d) : null;
    out.push({ title, url, publisher: publisher || null, publishedAt: t && !Number.isNaN(t.getTime()) ? t.toISOString() : null, feed });
  }
  return out
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, limit);
}

async function rss(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml" }, next: { revalidate: 900 } });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export async function getNews(symbol: string, companyName?: string | null, limit = 8): Promise<NewsResult | { error: string }> {
  const sym = symbol.toUpperCase();
  const yUrl = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`;
  const y = await rss(yUrl);
  const yh = y ? parseRss(y, "yahoo", limit) : [];
  if (yh.length >= 3) return { symbol: sym, headlines: yh, feed: "Yahoo Finance RSS", fetchedAt: new Date().toISOString() };
  const q = companyName ? `"${companyName.replace(/,? (Inc|Corp|Corporation|Ltd|Limited|Holdings|plc|N\.V\.)\.?$/i, "")}" OR ${sym} stock` : `${sym} stock`;
  const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:14d&hl=en-US&gl=US&ceid=US:en`;
  const g = await rss(gUrl);
  const gh = g ? parseRss(g, "google", limit) : [];
  const merged = [...yh, ...gh.filter((h) => !yh.some((x) => x.title.toLowerCase() === h.title.toLowerCase()))].slice(0, limit);
  if (!merged.length) return { error: "No headlines could be fetched right now." };
  return { symbol: sym, headlines: merged, feed: yh.length ? "Yahoo Finance RSS + Google News RSS" : "Google News RSS", fetchedAt: new Date().toISOString() };
}
