---
inclusion: fileMatch
fileMatchPattern: 'src/web/**'
---

# Web_App UI conventions

- **Design tokens.** Colors, radii, shadows, and fonts are CSS variables in `src/web/app.css` (`--accent`, `--spirit`, `--warn`, `--danger`, `--surface*`, `--border*`). Use them instead of new hex values. `app.css` is imported first in `App.tsx` so component stylesheets can override its primitives.
- **Primitives.** Reuse `.card`, `.card__header`, `.card__title`, `.card__subtitle`, `.btn` (`--primary`, `--spirit`, `--ghost`, `--sm`), `.field`, and `.text-input` before adding new component-level styles. Each component keeps its own stylesheet next to it.
- **Grid overflow.** Grid tracks that hold wide content (tables, logs) use `minmax(0, 1fr)`, and wide content scrolls inside its own wrapper. The page must not scroll sideways at 390 px.
- **Store access.** Components take an optional `store` prop (default `hauntedStore`) and an optional `api` prop (default `api`), and read state with `useStore(store, selector)`. This keeps them testable with `createHauntedStore()`.
- **Accessibility the tests rely on.** Critical popups use `role="alert"`, warning and recovery popups use `role="status"`, and the voice toggle is a checkbox with `role="switch"` labelled "Voice". In `ChatPage`, only the waiting indicator and the voice-failed note use `role="status"`; adding another breaks the proposal tests.
- **Tests.** Vitest globals and jest-dom are not enabled: import from `vitest`, call `cleanup()` in `afterEach`, and assert with plain `expect`. Web tests live in `test/web/` and run under jsdom.
- **Spooky, but readable.** Persona flavor belongs in copy and subtle motion (float, pulse). Respect `prefers-reduced-motion`, keep text contrast high, and never hide a number the user needs behind an animation.
