import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { applyPalette, currentPalette, PALETTES } from "./palettes";
import "./palette-picker.css";

function positionAppearance(trigger: HTMLButtonElement | null, panel: HTMLDivElement | null) {
  if (!trigger || !panel?.matches(":popover-open")) return;
  const viewportWidth = document.documentElement.clientWidth;
  const anchor = trigger.getBoundingClientRect();
  const bounds = panel.getBoundingClientRect();
  const top = anchor.bottom + 10 + bounds.height <= window.innerHeight - 12
    ? anchor.bottom + 10 : anchor.top - bounds.height - 10;
  panel.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`;
  panel.style.left = `${Math.max(12, Math.min(anchor.left, viewportWidth - bounds.width - 12))}px`;
}

export function PalettePicker({ showLabel = false }: { showLabel?: boolean }) {
  const [selected, setSelected] = useState(currentPalette);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => positionAppearance(trigger.current, panel.current);
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, showLabel]);
  const palette = PALETTES.find(item => item.id === selected)!;
  return <>
    <button ref={trigger} className="kw-appearance-trigger" type="button" title="外观"
      aria-label={`外观，当前配色：${palette.name}`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls="kw-appearance" onClick={() => {
        panel.current?.togglePopover();
        positionAppearance(trigger.current, panel.current);
      }}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h1.2a2.1 2.1 0 0 0 1.6-3.5 1.7 1.7 0 0 1 1.3-2.8H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z"/><circle cx="7.5" cy="11" r=".8"/><circle cx="10" cy="7" r=".8"/><circle cx="15" cy="7.5" r=".8"/></svg>
      {showLabel && <span>外观</span>}
    </button>
    <div ref={panel} id="kw-appearance" className="kw-appearance" popover="auto" role="dialog" aria-labelledby="kw-appearance-title"
      onToggle={event => setOpen(event.currentTarget.matches(":popover-open"))}>
      <header><h2 id="kw-appearance-title">外观</h2><button type="button" aria-label="关闭外观" popoverTarget="kw-appearance" popoverTargetAction="hide">×</button></header>
      <div className="kw-palette-list" role="radiogroup" aria-label="配色方案">
        {PALETTES.map(item => <label className="kw-palette-option" key={item.id} data-selected={selected === item.id}>
          <input type="radio" name="kw-palette" value={item.id} checked={selected === item.id} onChange={() => {
            applyPalette(item.id, true);
            setSelected(item.id);
          }}/>
          <span className="kw-palette-swatch" aria-hidden="true" style={{ background: item.colors.canvas, borderColor: item.colors.line, "--swatch-ink": item.colors.ink } as CSSProperties}>
            <i style={{ background: item.colors.rail }}/><i style={{ background: item.colors.surface }}/><i style={{ background: item.colors.accent }}/>
          </span>
          <span className="kw-palette-copy"><strong>{item.name}</strong><small>{item.description}</small></span>
          <span className="kw-palette-check" aria-hidden="true">{selected === item.id ? "✓" : ""}</span>
        </label>)}
      </div>
    </div>
  </>;
}
