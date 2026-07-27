# Stage 1 - UI Shell

Static calendar UI with hardcoded sample lessons. No backend, no Netlify
Functions, no AI. The goal here is purely to nail the layout and interaction
feel before wiring anything up.

## Current repository status

- `public/index.html` — full calendar grid, manual-add form UI, assistant
  input box UI. All "data" lives in a local JS array (`sampleLessons`) and
  is lost on refresh.

## Testing

Open `public/index.html` directly in a browser, or serve the `public/`
folder with any static server:

```bash
npx serve public
```

## Later stages

- No backend / storage (Stage 2)
- Manual add/delete don't persist anywhere (Stage 3)
- Assistant box is a visual placeholder only (Stage 4)
- No rate limiting (Stage 5)
