---
inclusion: fileMatch
fileMatchPattern: 'src/web/**'
---

# Web_App UI conventions

- **Design tokens.** Colors, radii, shadows, and fonts are CSS variables in `src/web/app.css`. Each tone has a base, a `-soft` fill, a `-line` border, and where needed a `-text` or `-glow` variant (`--accent`, `--spirit`, `--ok`, `--warn`, `--danger`), plus `--surface*`, `--border*`, `--text`, `--muted`, and `--faint`. Use them instead of new hex values; add a token to `app.css` when one is missing. `app.css` is imported first in `App.tsx` so component stylesheets can override its primitives.
- **Fonts.** Inter (UI), JetBrains Mono (container names, logs), and Cinzel (titles, `--font-display`) are self-hosted with `@fontsource-variable/*` imports in `main.tsx`. Never load fonts from a CDN.
- **Primitives.** Reuse `.card`, `.card__header`, `.card__title`, `.card__subtitle`, `.btn` (`--primary`, `--spirit`, `--ghost`, `--sm`, `--icon`), `.field`, `.select` (a wrapper around a native `<select>` plus a `.select__chevron` icon), `.text-input`, `.skeleton`, `.nowrap`, and `.visually-hidden` before adding new component-level styles. Each component keeps its own stylesheet next to it.
- **Icons and visuals.** Icons come from `lucide-react`; they scale with `font-size` and are `aria-hidden` unless given an aria prop. The ghost glyph (`GhostMark`) and the speaking bars (`Equalizer`) live in `components/visuals.tsx`. Do not use emoji as icons; they render differently on every OS.
- **Grid overflow.** Grid tracks that hold wide content (tables, logs) use `minmax(0, 1fr)`, and wide content scrolls or wraps inside its own wrapper. The page must not scroll sideways at 390 px. Below 600 px the container table is restyled as cards, so it keeps explicit ARIA table roles.
- **Alert popups.** The stack shows the newest popup first. With more than one, it collapses into a deck (CSS only) that fans out on hover or focus. Popups overlay the top of the chat column, so the conversation is anchored to the bottom of the chat.
- **Store access.** Components take an optional `store` prop (default `hauntedStore`) and an optional `api` prop (default `api`), and read state with `useStore(store, selector)`. This keeps them testable with `createHauntedStore()`. `voiceStatus[id] === "playing"` (set by the `AudioQueue` playback callbacks in `App.tsx`) drives the speaking indicators.
- **Accessibility the tests rely on.** Critical popups use `role="alert"`, warning and recovery popups use `role="status"`, and the voice toggle is a checkbox with `role="switch"` labelled "Voice". In `ChatPage`, only the waiting indicator and the voice-failed note use `role="status"`; adding another breaks the proposal tests. Labels hidden on narrow screens stay in the DOM (visually hidden), so accessible names such as "Send" and "Wake the ghost" do not change.
- **Tests.** Vitest globals and jest-dom are not enabled: import from `vitest`, call `cleanup()` in `afterEach`, and assert with plain `expect`. Web tests live in `test/web/` and run under jsdom.
- **Spooky, but readable.** Persona flavor belongs in copy and subtle motion (float, pulse, materialize). Respect `prefers-reduced-motion`, keep text contrast high, and never hide a number the user needs behind an animation.
