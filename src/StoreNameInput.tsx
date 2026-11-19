import { useId, useRef, useState } from "react";
import storeCatalog from "../supabase/functions/restaurant-analysis/store-catalog.json";

// Official shop list: https://marugo-s.com/ (checked 2026-11-01).
// Explicit selection fills official, Tabelog and Google Maps links; all remain editable.
export const STORE_CATALOG = storeCatalog;
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
