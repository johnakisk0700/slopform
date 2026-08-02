# ADR 0011: Commissioner for display, Sora for the wordmark

- Status: Accepted
- Date: 2026-08-02
- Supersedes: the “single family for display, UI and body” clause of
  [ADR 0005](0005-theming-and-dark-mode.md). The rest of ADR 0005 stands
  (tokens, `dark` class, semantic consumption, Greek capability).

## Decision

The admin panel uses **three** Fontsource-hosted variable families:

- **Manrope** (`@fontsource-variable/manrope`) — UI and body
  (`--jts-font-sans`). Greek-capable.
- **Commissioner** (`@fontsource-variable/commissioner`) — display headings
  (`--jts-font-display`). Greek-capable.
- **Sora** (`@fontsource-variable/sora`) — the “Join The Six” wordmark and
  nothing else (`--jts-font-brand`), i.e. `BrandLockup`. Latin only.

All three remain self-hosted (OFL). System sans stays the fallback under
Manrope.

## Why

- ADR 0005 required Greek so operator Greek and English stay visually aligned.
  Manrope and Commissioner both ship a `greek` subset, so the text of the panel
  meets that constraint.
- **The wordmark does not inherit that constraint.** It sets one fixed Latin
  string, so a Latin-only face costs the operator nothing there — and lifting
  the constraint is what allowed a face chosen for one job: answering the round
  product mark it stands beside. The Greek-capable variable families are almost
  all humanist; Sora's geometry (circular bowls, wide even rhythm) is what the
  mark's circular table and heads ask for.
- Commissioner stays on headings: the measured type scale and AA work already
  done against that pairing hold.

## Consequences

- `font-brand` / `--jts-font-brand` belong to `BrandLockup` alone. Using it for
  UI copy is a defect: the first Greek string would fall through to the display
  stack mid-sentence.
- `font-display` / `--jts-font-display` resolve to Commissioner; headings pick
  it up automatically. It is still the fallback under `--jts-font-brand`.
- A fourth family, or Sora leaking beyond the wordmark, requires a new ADR.
- [`docs/frontend/theming.md`](../frontend/theming.md) documents the split.

## References

- Fontsource Commissioner — <https://fontsource.org/fonts/commissioner>
- Fontsource Manrope — <https://fontsource.org/fonts/manrope>
- Fontsource Sora — <https://fontsource.org/fonts/sora>
- [`apps/admin/src/components/admin/BrandLockup.tsx`](../../apps/admin/src/components/admin/BrandLockup.tsx)
