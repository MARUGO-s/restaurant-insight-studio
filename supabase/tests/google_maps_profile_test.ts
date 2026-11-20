import { strict as assert } from "node:assert";
import { directPageEvidence, loadDirectPages } from "../functions/restaurant-analysis/direct-pages.ts";
import { MAPS_ADDRESS_SELECTOR, MAPS_NAME_SELECTOR } from "../functions/restaurant-analysis/google-maps-profile.ts";
import storeCatalog from "../functions/restaurant-analysis/store-catalog.json" with { type: "json" };

const official = "https://example.test/";
const mapsUrl = storeCatalog.find((store) => store.name === "ビストロ サヴァサヴァ")!.googleMapsUrl!;
const name = "ビストロ サヴァサヴァ";
const address = "東京都新宿区荒木町1-2";
const selected = (url = mapsUrl) => [{ id: "google_maps", url }];
const renderer = { accountId: "abcdef0123456789abcdef0123456789", token: "browser-test-token" };

function html(markup: string) {
  return new Response(markup, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function rendered(finalUrl = mapsUrl, body = `${name}\n${address}\n口コミの本文を含む表示ページ`) {
  const elements = (selector: string, text: string) => ({ selector, results: [{ text, width: 300, height: 30 }] });
  return Response.json({ success: true, meta: { finalUrl, status: 200 }, result: [
    elements("body", body), elements(MAPS_NAME_SELECTOR, name), elements(MAPS_ADDRESS_SELECTOR, `\uE0C8 ${address}`),
  ] });
}

Deno.test("Google Maps submits only the observed profile fields from a usable direct response", async () => {
  const get: typeof fetch = (url, options) => {
    assert.equal(url, mapsUrl);
    assert.equal(options?.method ?? "GET", "GET");
    return Promise.resolve(html(`<html><head><title>${name} - Google Maps</title></head><body><div role="main"><h1>${name}</h1>
      <button data-item-id="address">${address}</button><p>口コミの本文</p></div></body></html>`));
  };
  const pages = await loadDirectPages(official, selected(), get, [], renderer);
  const map = pages.find((page) => page.kind === "google-maps")!;
  assert.equal(map.status, "retrieved");
  assert.equal(map.url, mapsUrl);
  assert.match(map.retrievedAt!, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(map.text, `店名：${name}\n住所：${address}`);
  assert.ok(!directPageEvidence(pages).includes("口コミの本文"));
});

Deno.test("Google Maps tries the same place in a browser after a JavaScript shell", async () => {
  const requests: string[] = [];
  const alias = new URL(mapsUrl);
  alias.hostname = "www.google.co.jp";
  alias.search = "?hl=ja";
  const get: typeof fetch = (url, options) => {
    requests.push(String(url));
    if (url === mapsUrl) return Promise.resolve(html("<title>Google Maps</title><noscript>Enable JavaScript</noscript>"));
    const request = JSON.parse(String(options?.body));
    assert.equal(request.url, mapsUrl);
    assert.equal(request.waitForSelector.selector, MAPS_ADDRESS_SELECTOR);
    const patterns = request.allowRequestPattern.map((pattern: string) => new RegExp(pattern));
    assert.ok(patterns.some((pattern: RegExp) => pattern.test("https://maps.gstatic.com/maps/")));
    assert.ok(!patterns.some((pattern: RegExp) => pattern.test("https://www.google.com.example.test/")));
    return Promise.resolve(rendered(alias.href));
  };
  const pages = await loadDirectPages(official, selected(), get, [], renderer);
  const map = pages.find((page) => page.kind === "google-maps")!;
  assert.equal(requests.length, 2);
  assert.equal(map.status, "retrieved");
  assert.equal(map.method, "browser");
  assert.equal(map.url, alias.href);
  assert.equal(map.text, `店名：${name}\n住所：${address}`);
  assert.ok(!directPageEvidence(pages).includes("口コミの本文"));
});

Deno.test("Google Maps keeps script shells, unavailable profile fields, and changed place URLs unverified", async () => {
  for (const response of [rendered(mapsUrl, "Enable JavaScript"), rendered(mapsUrl, name), rendered(mapsUrl.replace("78fb05ead4a25b20", "78fb05ead4a25b21"))]) {
    const get: typeof fetch = (url) => Promise.resolve(url === mapsUrl ? html("<title>Google Maps</title>") : response);
    const pages = await loadDirectPages(official, selected(), get, [], renderer);
    const map = pages.find((page) => page.kind === "google-maps")!;
    assert.equal(map.status, "unavailable");
    assert.equal(map.text, undefined);
    assert.equal(map.retrievedAt, undefined);
    assert.match(map.reason!, /ブラウザー取得/);
  }
});

Deno.test("Google Maps skips unselected and unsupported URLs without requesting them", async () => {
  const get: typeof fetch = () => { throw new Error("Unexpected request"); };
  for (const url of ["", "https://maps.app.goo.gl/short", mapsUrl.replace("google.com", "google.com.example.test"), mapsUrl + "&q=other"]) {
    const pages = await loadDirectPages(official, selected(url), get, [], renderer);
    assert.equal(pages.find((page) => page.kind === "google-maps")?.status, "search_only");
  }
  const pages = await loadDirectPages(official, [], get, [], renderer);
  assert.ok(!pages.some((page) => page.kind === "google-maps"));
});
