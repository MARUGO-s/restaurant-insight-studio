import { load } from "npm:cheerio@1.1.2/slim";

export const MAPS_NAME_SELECTOR = '[role="main"] h1';
export const MAPS_ADDRESS_SELECTOR = '[role="main"] button[data-item-id="address"]';

const MAPS_HOSTS = new Set(["www.google.com", "google.com", "www.google.co.jp", "google.co.jp"]);
const MAPS_QUERY_KEYS = new Set(["hl", "entry", "g_ep"]);
const MAPS_PLACE_PATH = /^\/maps\/place\/[^/]+\/(?:[^/]+\/)*data=[^/]*!(?:1s0x[\da-f]+(?::|%3A)0x[\da-f]+|16s%2Fg%2F[\w-]+)(?=[!\/]|$)/i;

export function googleMapsPlacePath(url: URL | null) {
  if (!url || url.protocol !== "https:" || url.port || url.username || url.password ||
    !MAPS_HOSTS.has(url.hostname) || url.pathname.length > 2_000 || !MAPS_PLACE_PATH.test(url.pathname)) return null;
  return [...url.searchParams.keys()].every((key) => MAPS_QUERY_KEYS.has(key))
    ? url.pathname.replace(/\/$/, "").replace(/%[\da-f]{2}/gi, (encoded) => encoded.toUpperCase())
    : null;
}

export const MAPS_BROWSER_HOST_PATTERNS = [
  "^https://(?:www\\.)?google\\.(?:com|co\\.jp)/",
  "^https://(?:maps|www|ssl)\\.gstatic\\.com/",
  "^https://maps\\.googleapis\\.com/",
];

function mapsText(value: string) {
  return value.replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
}

export function extractGoogleMapsProfile(body: string, names: string[], addresses: string[]) {
  const visibleBody = mapsText(body);
  const visible = (items: string[]) => [...new Set(items.map(mapsText).filter((value) => value && visibleBody.includes(value)))];
  const [name, otherName] = visible(names);
  const [address, otherAddress] = visible(addresses);
  if (!name || name.length > 180 || otherName || !address || address.length < 6 || address.length > 300 || otherAddress || name === address) return null;

  return { title: name, text: `店名：${name}\n住所：${address}` };
}

export function extractGoogleMapsHtml(html: string) {
  const $ = load(html);
  $("script, style, noscript, template, [hidden], [aria-hidden=true]").remove();
  return extractGoogleMapsProfile(
    $("body").text(),
    $(MAPS_NAME_SELECTOR).toArray().map((element) => $(element).text()),
    $(MAPS_ADDRESS_SELECTOR).toArray().map((element) => $(element).text()),
  );
}
