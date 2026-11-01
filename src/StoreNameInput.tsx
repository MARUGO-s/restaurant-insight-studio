import { useId, useRef, useState } from "react";

// Official shop list: https://marugo-s.com/ (checked 2026-11-01).
// Selecting a store fills its official link; all fields remain editable.
export const STORE_CATALOG = [
  { name: "マルゴ", url: "https://bar-maru5.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13019866/" },
  { name: "マルゴ セカンド", url: "https://www.bar-052.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13045280/" },
  { name: "マルゴ グランデ", url: "https://marugo-s.com/g/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13085280/" },
  { name: "サンナナイチバル", url: "https://www.371-bar.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13181196/" },
  { name: "X&C/シェンロン&クラウディア", url: "https://claudia-shinjuku.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13266555/" },
  { name: "クラウディア2", url: "https://www.claudia2.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13161411/" },
  { name: "SOBA-JU / ソバージュ", url: "https://soba-ju.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13235855/" },
  { name: "ペロタ", url: "https://www.bar-pelota.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130402/13130671/" },
  { name: "トラットリア ブリッコラ", url: "https://trattoria-briccola.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13038992/" },
  { name: "ヴィオレット", url: "https://www.bar-violet.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13039572/" },
  { name: "マルゴ オット", url: "https://marugo-otto.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13198112/" },
  { name: "元祖どないや 新宿三丁目店", url: "https://donaiya-shinjuku3chome.com/", tabelogUrl: "https://tabelog.com/tokyo/A1304/A130401/13292284/" },
  { name: "マルゴ 四谷", url: "https://marugo-s.com/yotsuya/", tabelogUrl: "https://tabelog.com/tokyo/A1309/A130902/13245349/" },
  { name: "鮨こるり", url: "https://sushi-koruri.com/", tabelogUrl: "https://tabelog.com/tokyo/A1309/A130902/13285110/" },
  { name: "ビストロ サヴァサヴァ", url: "https://www.bistro-cavacava.com/", tabelogUrl: "https://tabelog.com/tokyo/A1309/A130903/13245351/" },
  { name: "マルゴエス", url: "https://marugo-s.com/s/", tabelogUrl: "https://tabelog.com/tokyo/A1310/A131003/13316863/" },
  { name: "マルゴ 丸の内", url: "https://marugo-s.com/m/", tabelogUrl: "https://tabelog.com/tokyo/A1302/A130201/13096436/" },
  { name: "焼肉MARUGO", url: "https://yakiniku05.com/", tabelogUrl: "https://tabelog.com/tokyo/A1301/A130102/13228595/" },
  { name: "エリックス バイ エリック トロション", url: "https://erics-marunouchi.com/", tabelogUrl: "https://tabelog.com/tokyo/A1302/A130201/13214489/" },
  { name: "ミタン", url: "https://mitan-marunouchi.com/", tabelogUrl: "https://tabelog.com/tokyo/A1302/A130201/13214494/" },
  { name: "BLU NERO / ブルネロ", url: "https://blu-nero.com/", tabelogUrl: "https://tabelog.com/tokyo/A1302/A130201/13324500/" },
  { name: "マルゴ 新橋", url: "https://marugo-s.com/shinbashi/", tabelogUrl: "https://tabelog.com/tokyo/A1301/A130103/13228615/" },
  { name: "マルゴ D", url: "https://marugo-d.com/", tabelogUrl: "https://tabelog.com/aichi/A2305/A230503/23091696/" },
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
    <small id={`${id}-hint`} className="store-name-hint">選択すると公式サイト・食べログURLを入力します。店舗名・URLは自由に編集できます。</small>
  </div>;
}
