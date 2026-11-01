import { useId, useRef, useState } from "react";

// Official shop list: https://marugo-s.com/ (checked 2026-11-01).
// Explicit selection fills official, Tabelog and Google Maps links; all remain editable.
export const STORE_CATALOG = [
  { name: "マルゴ", url: "https://bar-maru5.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13019866/", googleMapsUrl: "https://www.google.co.jp/maps/place/MARUGO/@35.690922,139.705925,18z/data=!3m1!4b1!4m2!3m1!1s0x60188cdb64edfa93:0xdedb49f96ace6287?hl=ja" },
  { name: "マルゴ セカンド", url: "https://www.bar-052.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13045280/", googleMapsUrl: "https://www.google.co.jp/maps/place/MARUGO%E2%85%A1/@35.69126,139.706671,18z/data=!3m1!4b1!4m2!3m1!1s0x60188cdc9c4265bb:0x4e74da75650b236?hl=ja" },
  { name: "マルゴ グランデ", url: "https://marugo-s.com/g/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13085280/", googleMapsUrl: "https://www.google.co.jp/maps/place/MARUGO+GRANDE/@35.690911,139.705776,17z/data=!3m1!4b1!4m2!3m1!1s0x60188cdc9eb3a197:0x5d8bc9b17d810961?hl=ja" },
  { name: "サンナナイチバル", url: "https://www.371-bar.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13181196/", googleMapsUrl: "https://www.google.co.jp/maps/place/371+SAN+NANA+ICHI+BAR/@35.690776,139.7057027,19z/data=!4m7!1m4!3m3!1s0x0:0x0!2zMzXCsDQxJzI2LjgiTiAxMznCsDQyJzIyLjUiRQ!3b1!3m1!1s0x0000000000000000:0x3dcb576cd3459397?hl=ja" },
  { name: "X&C/シェンロン&クラウディア", url: "https://claudia-shinjuku.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13266555/", googleMapsUrl: "https://www.google.com/maps/place/%E3%82%82%E3%81%A4%E7%84%BC%E3%81%8D+%E8%A1%97%E4%B8%AD%E8%8F%AFX%EF%BC%86C/@35.690714,139.706421,17z/data=!3m1!5s0x60188cdb5ff82cb9:0x2786ca8594385898!4m6!3m5!1s0x60188daf3acd18ef:0xc01df665d6d1b087!8m2!3d35.6907211!4d139.7064247!16s%2Fg%2F11pdyb2p5n?hl=ja&entry=ttu&g_ep=EgoyMDI1MDQxMy4wIKXMDSoJLDEwMjExNDUzSAFQAw%3D%3D" },
  { name: "クラウディア2", url: "https://www.claudia2.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13161411/", googleMapsUrl: "https://www.google.co.jp/maps/place/Claudia2/@35.6912121,139.7052271,18z/data=!3m2!4b1!5s0x60188cdc9d703d15:0x79eff76246dcdd8a!4m6!3m5!1s0x60188cdb6279348b:0x36e7e52c4211851d!8m2!3d35.6912121!4d139.7065146!16s%2Fg%2F1yglqbc0r?entry=ttu&g_ep=EgoyMDI1MDQxNi4xIKXMDSoJLDEwMjExNDUzSAFQAw%3D%3D" },
  { name: "SOBA-JU / ソバージュ", url: "https://soba-ju.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13235855/", googleMapsUrl: "https://www.google.co.jp/maps/place/SOBA-JU(%E3%82%BD%E3%83%90%E3%83%BC%E3%82%B8%E3%83%A5)/@35.6911514,139.705071,18z/data=!3m2!4b1!5s0x60188c5808949e7d:0x6962b5183ec876a7!4m6!3m5!1s0x60188d1963662979:0x8b7868b10e56602d!8m2!3d35.6911514!4d139.7063585!16s%2Fg%2F11fm4j8lrv?hl=ja&entry=ttu&g_ep=EgoyMDI1MDQxNi4xIKXMDSoASAFQAw%3D%3D" },
  { name: "ペロタ", url: "https://www.bar-pelota.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130402/13130671/", googleMapsUrl: "https://www.google.co.jp/maps/place/%E3%83%90%E3%83%AB+%E3%83%9A%E3%83%AD%E3%82%BF/@35.689227,139.70731,17z/data=!3m1!4b1!4m2!3m1!1s0x0:0x60d5cdcabf1e15b4" },
  { name: "トラットリア ブリッコラ", url: "https://trattoria-briccola.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13038992/", googleMapsUrl: "https://www.google.com/maps/place/%E3%83%88%E3%83%A9%E3%83%83%E3%83%88%E3%83%AA%E3%82%A2%E3%83%BB%E3%83%96%E3%83%AA%E3%83%83%E3%82%B3%E3%83%A9/@35.6900271,139.7036051,15z/data=!3m1!5s0x60188cdc80ff653d:0x7ca932c965dec642!4m6!3m5!1s0x60188cdc805386ed:0xeb936b3901239811!8m2!3d35.6918428!4d139.7066256!16s%2Fg%2F1tfchrng?entry=ttu&g_ep=EgoyMDI1MDUwNy4wIKXMDSoJLDEwMjExNDUzSAFQAw%3D%3D" },
  { name: "ヴィオレット", url: "https://www.bar-violet.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13039572/", googleMapsUrl: "https://www.google.co.jp/maps/place/Bar+Violet/@35.6917911,139.7061683,19z/data=!3m1!4b1!4m2!3m1!1s0x60188cdc813ecc3b:0xdd581b210cf77836?hl=ja" },
  { name: "マルゴ オット", url: "https://marugo-otto.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13198112/", googleMapsUrl: "https://www.google.co.jp/maps/place/MARUGO+OTTO+%E3%83%9E%E3%83%AB%E3%82%B4%E3%83%BB%E3%82%AA%E3%83%83%E3%83%88/@35.6929341,139.7011695,18z/data=!3m1!5s0x60188cd9f276b195:0x3e80e3e7739766c6!4m15!1m8!3m7!1s0x60188cd9f23e5d4b:0x875e3c75159166aa!2z44CSMTYwLTAwMjIg5p2x5Lqs6YO95paw5a6_5Yy65paw5a6_77yT5LiB55uu77yS77yR4oiS77yXIOadseaWsOODk-ODqw!3b1!8m2!3d35.6930779!4d139.7023497!16s%2Fg%2F12hl74qps!3m5!1s0x60188cdcffffffff:0xb29c4031263ee4c2!8m2!3d35.6930779!4d139.7023497!16s%2Fg%2F11pz0ktchn?entry=ttu&g_ep=EgoyMDI1MDUxNS4wIKXMDSoASAFQAw%3D%3D" },
  { name: "元祖どないや 新宿三丁目店", url: "https://donaiya-shinjuku3chome.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13292284/", googleMapsUrl: "https://www.google.com/maps/place/%E5%85%83%E7%A5%96%E3%81%A9%E3%81%AA%E3%81%84%E3%82%84+%E6%96%B0%E5%AE%BF%E4%B8%89%E4%B8%81%E7%9B%AE%E5%BA%97/@35.6911279,139.7066842,21z/data=!4m6!3m5!1s0x60188d000c9e4389:0xd5efa5eac6146faf!8m2!3d35.6911279!4d139.7066842!16s%2Fg%2F11vjxw56p6?entry=ttu&g_ep=EgoyMDI1MDYyMi4wIKXMDSoASAFQAw%3D%3D" },
  { name: "マルゴ 四谷", url: "https://marugo-s.com/yotsuya/", tabelogUrl: "https://tabelog.com/tokyo/A1309/A130902/13245349/", googleMapsUrl: "https://www.google.com/maps/place/%E3%83%9E%E3%83%AB%E3%82%B4%E5%9B%9B%E8%B0%B7%EF%BC%88MARUGO+YOTSUYA%EF%BC%89/@35.6878861,139.7266763,17z/data=!3m2!4b1!5s0x60188c8b05c6fc41:0xa01e1a6a43ca9313!4m6!3m5!1s0x60188d6fd68898dd:0x43598da9eae7640a!8m2!3d35.6878818!4d139.7292512!16s%2Fg%2F11k69b9mlc?hl=ja&entry=ttu&g_ep=EgoyMDI1MDQxNC4xIKXMDSoJLDEwMjExNDUzSAFQAw%3D%3D" },
  { name: "鮨こるり", url: "https://sushi-koruri.com/", tabelogUrl: "https://tabelog.com/tokyo/A1309/A130902/13285110/", googleMapsUrl: "https://www.google.com/maps/place/%E9%AE%A8%E3%81%93%E3%82%8B%E3%82%8A/@35.6875964,139.7267064,17z/data=!3m2!4b1!5s0x60188c8b05c6fc41:0xa01e1a6a43ca9313!4m15!1m8!3m7!1s0x60188d9f495b8bd3:0x214188809de3c576!2z6a6o44GT44KL44KK!8m2!3d35.6875921!4d139.7292813!10e2!16s%2Fg%2F11v0bqh790!3m5!1s0x60188d9f495b8bd3:0x214188809de3c576!8m2!3d35.6875921!4d139.7292813!16s%2Fg%2F11v0bqh790?hl=ja&entry=ttu&g_ep=EgoyMDI1MDUyNi4wIKXMDSoJLDEwMjExNDUzSAFQAw%3D%3D" },
  { name: "ビストロ サヴァサヴァ", url: "https://www.bistro-cavacava.com/", tabelogUrl: "https://tabelog.com/tokyo/A1309/A130903/13245351/", googleMapsUrl: "https://www.google.com/maps/place/%E3%83%93%E3%82%B9%E3%83%88%E3%83%AD+%E3%82%B5%E3%83%B4%E3%82%A1%E3%83%BB%E3%82%B5%E3%83%B4%E3%82%A1/@35.6903701,139.7196531,17z/data=!3m2!4b1!5s0x60188cf20c4ebabf:0xb1f39a458cbb81be!4m6!3m5!1s0x60188d62f0d58f53:0x78fb05ead4a25b20!8m2!3d35.6903658!4d139.722228!16s%2Fg%2F11jr9nd0g_?entry=ttu&g_ep=EgoyMDI1MDYwMS4wIKXMDSoASAFQAw%3D%3D" },
  { name: "マルゴエス", url: "https://marugo-s.com/s/", tabelogUrl: "https://tabelog.com/tokyo/A1310/A131003/13316863/", googleMapsUrl: "https://www.google.com/maps/place/%E3%83%9E%E3%83%AB%E3%82%B4%E3%82%A8%E3%82%B9+%2F+MARUGO+S/@35.7036834,139.7494073,17z/data=!3m2!4b1!5s0x60188c474e5cccbb:0xb18e9c9d57bbc29c!4m6!3m5!1s0x60188d7233cfde01:0xc83b462f38dab4c2!8m2!3d35.7036834!4d139.7519822!16s%2Fg%2F11ms3ddn0z?entry=ttu&g_ep=EgoyMDI2MTAyOC4wIKXMDSoASAFQAw%3D%3D" },
  { name: "マルゴ 丸の内", url: "https://marugo-s.com/m/", tabelogUrl: "https://tabelog.com/tokyo/A1302/A130201/13096436/", googleMapsUrl: "https://www.google.co.jp/maps/place/%E3%83%9E%E3%83%AB%E3%82%B4%E4%B8%B8%E3%81%AE%E5%86%85/@35.678814,139.763246,17z/data=!3m1!4b1!4m2!3m1!1s0x0:0x5d2f64a7c901d10a" },
  { name: "焼肉MARUGO", url: "https://yakiniku05.com/", tabelogUrl: "https://tabelog.com/tokyo/A1301/A130102/13228595/", googleMapsUrl: "https://www.google.co.jp/maps/place/%E7%84%BC%E8%82%89MARUGO/@35.6777636,139.7589031,17z/data=!3m2!4b1!5s0x343e5ff46a30eebd:0x4fa0a371bb6a6ae3!4m6!3m5!1s0x60188b21119bd1a5:0xe8f60bb4278a64de!8m2!3d35.6777593!4d139.761478!16s%2Fg%2F11fggxlmhn?entry=ttu&g_ep=EgoyMDI1MDYwNC4wIKXMDSoASAFQAw%3D%3D" },
  { name: "エリックス バイ エリック トロション", url: "https://erics-marunouchi.com/", tabelogUrl: "https://tabelog.com/tokyo/A1302/A130201/13214489/", googleMapsUrl: "https://www.google.co.jp/maps/place/eric%E2%80%99S+by+Eric+Trochon/@35.6822897,139.7620287,17z/data=!3m2!4b1!5s0x60188bf9b158dbad:0x50960e978fb27134!4m6!3m5!1s0x60188bf9b1ec7fd9:0x34c63b86b6090b42!8m2!3d35.6822854!4d139.7646036!16s%2Fg%2F11fztw890z?entry=ttu&g_ep=EgoyMDI1MDYxMS4wIKXMDSoASAFQAw%3D%3D" },
  { name: "ミタン", url: "https://mitan-marunouchi.com/", tabelogUrl: "https://tabelog.com/tokyo/A1302/A130201/13214494/", googleMapsUrl: "https://www.google.co.jp/maps/place/MITAN/@35.6827014,139.7614344,16z/data=!3m2!4b1!5s0x60188bf9b158dbad:0x1342ed45d4558396!4m6!3m5!1s0x60188bf9b6177bb3:0x82a2ea59923d4a99!8m2!3d35.6827014!4d139.7640147!16s%2Fg%2F11fj4bvl8m?entry=ttu&g_ep=EgoyMDI1MDYxNi4wIKXMDSoASAFQAw%3D%3D" },
  { name: "BLU NERO / ブルネロ", url: "https://blu-nero.com/", tabelogUrl: "https://tabelog.com/tokyo/A1302/A130201/13324500/", googleMapsUrl: "https://www.google.com/maps/place/BLU+NERO/@35.6808746,139.7683135,17z/data=!3m2!4b1!5s0x60188bfd00bcd115:0xd00ed6bbeff5b27c!4m6!3m5!1s0x60188b9bba72f5d5:0x3aaf4298abd2ed12!8m2!3d35.6808703!4d139.7708884!16s%2Fg%2F11zdq88b3n?hl=ja&entry=ttu&g_ep=EgoyMDI2MDkyMi4wIKXMDSoASAFQAw%3D%3D" },
  { name: "マルゴ 新橋", url: "https://marugo-s.com/shinbashi/", tabelogUrl: "https://tabelog.com/tokyo/A1301/A130103/13228615/", googleMapsUrl: "https://www.google.co.jp/maps/place/%E3%83%9E%E3%83%AB%E3%82%B4/@35.665814,139.7564337,17z/data=!3m2!4b1!5s0x60188bea35817e09:0x7dd4f21926d8aa32!4m6!3m5!1s0x60188bc66f06aaa7:0x18b7dc63b457cebc!8m2!3d35.665814!4d139.7564337!16s%2Fg%2F11h271hn8l?entry=ttu&g_ep=EgoyMDI1MDYxNy4wIKXMDSoASAFQAw%3D%3D" },
  { name: "マルゴ D", url: "https://marugo-d.com/", tabelogUrl: "https://tabelog.com/aichi/A2305/A230503/23091696/", googleMapsUrl: "https://www.google.com/maps/place/MARUGO-D/@34.9921637,137.0096263,17z/data=!3m1!5s0x60049cf109f7dde9:0x4296c1bd85bc787f!4m15!1m8!3m7!1s0x60049d5ac9cf498d:0x57a957f3bb74b1b8!2sMARUGO-D!8m2!3d34.9921637!4d137.0122012!10e2!16s%2Fg%2F11m5cnsycp!3m5!1s0x60049d5ac9cf498d:0x57a957f3bb74b1b8!8m2!3d34.9921637!4d137.0122012!16s%2Fg%2F11m5cnsycp?entry=ttu&g_ep=EgoyMDI1MDYyMi4wIKXMDSoASAFQAw%3D%3D" },
];
export const STORE_NAMES = STORE_CATALOG.map(store => store.name);
const normalized = (value: string) => value.normalize("NFKC").replace(/\s/g, "").toLocaleLowerCase("ja");
export function storeNameOptions(query: string) {
  return STORE_NAMES.filter((name) => normalized(name).includes(normalized(query)));
}

export function officialStoreUrl(name: string) {
  return STORE_CATALOG.find(store => normalized(store.name) === normalized(name))?.url ?? "";
}

export function StoreNameInput({ value, onChange, onSelectStore }: { value: string; onChange: (value: string) => void; onSelectStore?: (store: typeof STORE_CATALOG[number]) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const options = storeNameOptions(query);
  const close = () => { setOpen(false); setActive(-1); };
  const choose = (name: string) => {
    onChange(name);
    const store = STORE_CATALOG.find(item => item.name === name);
    if (store) onSelectStore?.(store);
    close(); input.current?.focus();
  };
  const highlight = (index: number) => {
    setActive(index);
    requestAnimationFrame(() => document.getElementById(`${id}-option-${index}`)?.scrollIntoView({ block: "nearest" }));
  };
  return <div className="store-name-field" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  }}>
    <label htmlFor={`${id}-input`}>店舗名</label>
    <div className="store-name-control">
      <input ref={input} id={`${id}-input`} required value={value} placeholder="例：マルゴ四谷"
        role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`}
        aria-describedby={`${id}-hint`} aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
        autoComplete="off" onChange={(event) => {
          onChange(event.target.value); setQuery(event.target.value); setActive(-1); setOpen(true);
        }} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") { if (open) event.preventDefault(); close(); }
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) { setQuery(""); setOpen(true); highlight(event.key === "ArrowDown" ? 0 : STORE_NAMES.length - 1); }
            else if (options.length) highlight(event.key === "ArrowDown" ? (active + 1) % options.length : (active <= 0 ? options.length : active) - 1);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (active >= 0 && options[active]) choose(options[active]); else close();
          } else if (event.key === "Tab") close();
        }}/>
      <button type="button" className="store-name-toggle" aria-label="店舗一覧を開閉" aria-expanded={open}
        aria-controls={`${id}-list`} onClick={() => {
          if (open) close(); else { setQuery(""); setActive(-1); setOpen(true); }
          input.current?.focus();
        }}>▾</button>
      {open && <ul id={`${id}-list`} className="store-name-options" role="listbox" aria-label="店舗候補">
        {options.map((name, index) => <li key={name} id={`${id}-option-${index}`} role="option"
          aria-selected={active === index} onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(name)}>{name}</li>)}
        {!options.length && <li role="presentation" className="store-name-empty">候補はありません。入力した店舗名をそのまま使えます。</li>}
      </ul>}
    </div>
    <small id={`${id}-hint`} className="store-name-hint">選択すると公式サイト・食べログ・Google マップのURLを入力します。店舗名・URLは自由に編集できます。</small>
  </div>;
}
