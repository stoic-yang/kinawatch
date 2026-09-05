import { useCallback, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & {
  value: string;
  visible: boolean;
};

export function LongformTextarea({ value, visible, ...props }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const element = ref.current;
    if (!element || !element.getBoundingClientRect().width) return;
    const scrollY = window.scrollY;
    element.style.height = "auto";
    const border = element.offsetHeight - element.clientHeight;
    element.style.height = `${element.scrollHeight + border}px`;
    if (window.scrollY !== scrollY) window.scrollTo({ top: scrollY, behavior: "instant" });
  }, []);

  useLayoutEffect(() => {
    if (visible) resize();
  }, [value, visible, resize]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let contentWidth: number | undefined;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === contentWidth) return;
      // Padding can change wrapping at a fixed outer width. Ignore height-only
      // observations produced by resize() to avoid a measurement loop.
      contentWidth = entry.contentRect.width;
      resize();
    });
    observer?.observe(element);
    window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resize); };
  }, [resize]);

  return <textarea {...props} ref={ref} value={value} />;
}
