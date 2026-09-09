# Styling & Code-Sharing Best Practices

Design-system conventions and React patterns for the web app
(`apps/web`). Moved out of `AGENTS.md` to keep that file focused on
hard constraints and bug-prevention gotchas — this is reference
documentation for day-to-day component/style work.

## Design tokens — single source of truth

All colours live in `apps/web/src/styles/theme.css` as CSS custom properties. **Never introduce a raw hex or `rgba()` value directly in a component CSS file** — map it to a token instead.

Token taxonomy:

| Prefix | Purpose |
|---|---|
| `--text-*` | Readable text; always contrast-safe on the current surface |
| `--surface-*` | Panel/overlay backgrounds |
| `--border-*` | Dividers, outlines, separators |
| `--accent-*` | Brand colours, data callouts, navigation elements |
| `--status-*` | Semantic colours — `ok/warn/danger/info` |

**Theme switching** requires zero component changes: add a `[data-theme="..."]` block to `theme.css`, then call `document.documentElement.dataset.theme = 'light'`.

## CSS architecture

- **CSS Modules** (`.module.css`) for all component styles — class names are locally scoped, no global leakage.
- **`apps/web/src/index.css`** for resets, global element defaults (`body`, `html`, `#root`), and map-library global selectors only. Never put component styles here.
- **`apps/web/src/styles/theme.css`** for design tokens only — no layout, no selectors other than `:root` and `[data-theme="..."]`.
- Put truly shared layout primitives (e.g. a `.visually-hidden` utility) in `apps/web/src/styles/utils.css` if they accumulate. Do not put them in `index.css`.
- **Never use inline `style={{}}` props** in React except for purely dynamic computed values (e.g. a position derived from state). Static colours/spacing always go in CSS.

## Global font baseline (`apps/web/src/index.css`)

`body` sets the baseline `font-size: 12px` and `font-family`. The `*` reset includes `font-size: inherit` and `font-family: inherit` so that form elements (`<button>`, `<input>`, `<select>`) — which browsers do **not** inherit font by default — automatically pick up their container's size.

```css
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-size: inherit;
  font-family: inherit;
}

html, body, #root {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-size: 12px;
  font-family: system-ui, sans-serif;
}
```

**Rules that follow from this:**
- **Never set `font-size` on a button or input just to match its context.** Inheritance handles it.
- **Only set `font-size` in a component CSS module when the size genuinely differs from the parent container.**
- A component panel that wants a consistent internal size sets it once on its root element. All children — including buttons and inputs — inherit automatically.

## Avoiding duplication in CSS Modules

1. **Shared `.module.css`** — extract a repeated visual pattern into `apps/web/src/styles/shared.module.css` and import those class names where needed.
2. **`composes`** — CSS Modules' `composes` keyword lets a local class inherit from another module's class without copy-pasting:
   ```css
   /* shared.module.css */
   .badge { display: inline-flex; padding: 1px 6px; border-radius: 10px; font-size: 10px; }

   /* AerodromePopup.module.css */
   .pprBadge { composes: badge from './shared.module.css'; color: var(--accent-yellow); }
   ```
3. **CSS custom properties as API** — pass contextual values from a parent component via a CSS variable on the element's `style` prop rather than spawning variant classes:
   ```tsx
   <div className={styles.pill} style={{ '--pill-color': color } as React.CSSProperties}>
   ```
   ```css
   .pill { color: var(--pill-color, var(--text-muted)); }
   ```

## Avoiding duplication in React components

- **Extract a component** as soon as the same JSX tree appears in more than one place.
- **Custom hooks** encapsulate shared stateful logic (`useFlightLog`, `useRuler`, etc.). Don't duplicate `useState`/`useEffect` blocks.
- **Avoid prop-drilling more than 2 levels** — use React Context for read-many data (e.g. map instance, theme). Keep Context values stable.
- **`ref` as a prop (React 19)** — pass refs directly; `forwardRef` is no longer needed.

## Memoization (React 19 + Compiler)

React 19 ships with **React Compiler**, which automatically applies memoization. When it is active, **do not add manual `useMemo` / `useCallback` / `React.memo`** — the compiler handles it more precisely than hand-written code.

When React Compiler is **not** active (or as an explicit escape hatch):
- **`useMemo`** — cache expensive derived values and objects/arrays used as `useEffect` dependencies or passed to memoized children.
- **`useCallback`** — stabilise callbacks passed to `React.memo` children, or used inside `useEffect` dependency arrays.
- **`React.memo`** — wrap leaf components that receive stable props but live inside frequently-rendering parents.
- **Never construct a new object/array in a JSX prop** that flows into a `useEffect` dependency — it changes reference every render.

Regardless of compiler status, keep Context values referentially stable: wrap the context object in `useMemo`.

## Performance rules

- **`isAnimationActive={false}`** on all Recharts `<Line>`/`<Area>` — animation is expensive at 60 fps with live data.
- **Event listeners on the map** — always remove them in the cleanup return of `useEffect` to prevent memory leaks on hot-reload.
- **Dynamic `import()`** (lazy loading) for heavy panels not visible on first paint. Wrap with `<Suspense>`.
- Prefer **CSS transitions** over JS-driven animations. CSS runs on the compositor thread and does not block React rendering.
- **Async form actions (React 19)** — use `useActionState` + `startTransition` for async submissions instead of manually managing `isPending` / `error` state.

## Contrast requirements

New text colours must meet minimum contrast against `--surface-base` (`#0a0e16`):

| Token | Ratio | Permitted use |
|---|---|---|
| `--text-primary` | 6.8:1 | Any body text, values |
| `--text-secondary` | ~4.9:1 | Secondary body copy |
| `--text-muted` | ~3.5:1 | UI labels, sub-info |
| `--text-faint` | ~2.5:1 | Section headers, decorative — never body copy |
| `--text-placeholder` | ~2.0:1 | `::placeholder` only |
