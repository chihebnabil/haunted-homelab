import { useId } from "react";
import "./visuals.css";

export interface GhostMarkProps {
  className?: string;
}

/**
 * The ghost glyph used for the logo, the chat avatar, and the empty chat state. Decorative only.
 * It is drawn in `currentColor`, so each place tints it with its own color.
 */
export function GhostMark({ className }: GhostMarkProps) {
  // useId returns values such as ":r1:", which are awkward inside url(#...) references.
  const gradientId = `ghost-body-${useId().replace(/:/g, "")}`;
  return (
    <svg
      className={className ? `ghost-mark ${className}` : "ghost-mark"}
      // Cropped to the ghost, so 1em is the height of the ghost itself.
      viewBox="4.4 2.6 15.2 19.4"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.3" stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.45" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M5 20V10a7 7 0 0 1 14 0v10q-2.33 2.8-4.67 0q-2.33 2.8-4.66 0q-2.34 2.8-4.67 0Z"
      />
      <ellipse className="ghost-mark__eye" cx="9.4" cy="10.4" rx="1.3" ry="1.65" />
      <ellipse className="ghost-mark__eye" cx="14.6" cy="10.4" rx="1.3" ry="1.65" />
      <ellipse className="ghost-mark__mouth" cx="12" cy="14.5" rx="1.05" ry="1.25" />
    </svg>
  );
}

/** Animated bars that show the ghost is speaking. Decorative only. */
export function Equalizer({ className }: { className?: string }) {
  return (
    <span className={className ? `equalizer ${className}` : "equalizer"} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
