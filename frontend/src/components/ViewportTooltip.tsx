import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface ViewportTooltipAnchor {
  x: number;
  top: number;
  bottom: number;
}

export function ViewportTooltip({
  id,
  className,
  anchor,
  side,
  align = "center",
  onDismiss,
  children,
}: {
  id?: string;
  className: string;
  anchor: ViewportTooltipAnchor;
  side: "above" | "below";
  align?: "center" | "after";
  onDismiss: () => void;
  children: ReactNode;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    const bounds = tooltip.getBoundingClientRect();
    const margin = 12;
    const gap = 8;

    let left = anchor.x - bounds.width / 2;
    if (align === "after") {
      left = anchor.x + gap;
      if (left + bounds.width > window.innerWidth - margin) {
        left = anchor.x - gap - bounds.width;
      }
    }
    left = Math.max(
      margin,
      Math.min(window.innerWidth - margin - bounds.width, left),
    );

    const above = anchor.top - gap - bounds.height;
    const below = anchor.bottom + gap;
    let top = side === "above" ? above : below;
    if (
      side === "above" &&
      above < margin &&
      below + bounds.height <= window.innerHeight - margin
    ) {
      top = below;
    } else if (
      side === "below" &&
      below + bounds.height > window.innerHeight - margin &&
      above >= margin
    ) {
      top = above;
    }
    top = Math.max(
      margin,
      Math.min(window.innerHeight - margin - bounds.height, top),
    );

    setPosition((previous) =>
      previous?.left === left && previous.top === top ? previous : { left, top },
    );
  }, [align, anchor.bottom, anchor.top, anchor.x, children, side]);

  useEffect(() => {
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [onDismiss]);

  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      className={`viewport-tooltip ${className}`}
      role="tooltip"
      style={{
        position: "fixed",
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
