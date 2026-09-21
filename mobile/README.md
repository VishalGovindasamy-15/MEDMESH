# MedMesh — Expo app

One React Native codebase serving the public portal, the 108 dispatcher console,
the hospital portal, the ambulance crew app and the government analytics
dashboard. Layout adapts across phone, tablet and desktop from a single
`useResponsive` hook.

```bash
npm install
npm run web          # browser
npm start            # Expo Go / simulator (scan the QR)
npm run typecheck    # tsc --noEmit
```

The API is expected on `:8000`. Base-URL resolution is per platform and is
documented at the top of `src/api/client.ts`; override with
`EXPO_PUBLIC_API_URL`.

## Structure

```
app/                     expo-router routes — the file path IS the route
  _layout.tsx            providers: theme → auth → session gate → live feed
  index.tsx              public capacity directory
  facility/[id].tsx      facility detail, roster, trust breakdown, 24 h history
  doctors.tsx            specialist cover grouped by facility
  sign-in.tsx            staff sign-in + pilot accounts
  console/index.tsx      108 incident queue + intake + fleet
  console/[id].tsx       incident workspace: shortlist, commit, holds, re-route
  dashboard.tsx          hospital portal: quick-update keypad, roster, inbound
  crew.tsx               crew app: destination, route, arrival capacity, re-route
  analytics/index.tsx    district rollup, SLA, surge control, export
  analytics/[district].tsx
  account.tsx            session, role capability, platform health, diagnostics

src/
  api/client.ts          typed fetch, platform-aware base URL, ApiError
  api/types.ts           domain types (hand-narrowed, not codegen)
  state/AuthProvider     session, refresh, role helpers
  state/LiveProvider     WebSocket feed, reconnect/backoff, staleness tracking
  state/SessionGate      holds the tree until the stored session resolves
  theme/tokens.ts        every colour, size and space value in the app
  ui/index.tsx           design system primitives
  ui/Icon.tsx            hand-built icon set, one stroke weight
  ui/useResponsive.ts    breakpoints + gutter + column count
  ui/Shell.tsx           desktop rail / mobile tab bar / page header
  components/            MapCanvas · RouteCanvas · FacilityRow · ReportSheet
```

## Two conventions worth following

**Never hardcode a colour, font size or radius in a screen.** They resolve
through `useTheme()` → `theme/tokens.ts`. That is what makes the dark variant a
token swap rather than a rewrite, and it is why the two themes stay in sync.

**Never call `api.get` with a token in a screen's mount effect without the
session being resolved.** `SessionGate` in `_layout.tsx` guarantees this for the
whole tree — do not bypass it by mounting providers outside the gate, or every
authenticated screen will fire its first request anonymously and render a 401
error state on a valid session. That bug is why the gate exists.

## Breakpoints

| Width | Layout |
|---|---|
| `< 620` | phone — single column, bottom tab bar |
| `620–1024` | tablet — two-column grids, bottom tab bar |
| `>= 1024` | desktop — persistent 232px left rail, multi-column ops layouts |
