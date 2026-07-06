/**
 * Plain-object design tokens. Deliberately framework-free (no JSX, no
 * react-native-web) so both the Expo app and the Vite PWA can import the
 * same values without needing a shared component-rendering layer yet.
 *
 * Identity: badgr.me wears a badger's coat — charcoal fur for the surfaces,
 * the cream head-stripe for text, silvered grey for secondary, and one
 * honey-amber accent (honey badger energy: it does not let things go).
 * Rusty red for destructive actions.
 */
export const colors = {
  background: "#17181A",
  surface: "#212227",
  surfaceRaised: "#2B2D33",
  textPrimary: "#F4F2EA",
  textSecondary: "#9BA0A8",
  accent: "#F0A32F",
  accentSoft: "#342811",
  onAccent: "#201603",
  danger: "#E4574F",
  dangerSoft: "#351B1B",
  border: "#34373E",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radii = {
  sm: 8,
  md: 14,
  lg: 22,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 30, fontWeight: "800", letterSpacing: -0.8 },
  title: { fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  body: { fontSize: 15, fontWeight: "500", letterSpacing: 0 },
  caption: { fontSize: 13, fontWeight: "500", letterSpacing: 0.1 },
} as const;

/**
 * The icon set, as bare 24×24 stroke path data (round caps, no fill) so each
 * platform renders it natively — inline <svg> on web, react-native-svg on
 * mobile. Hand-drawn for this app; stroke everything at width 2.
 */
export const iconPaths = {
  /** Bell — the app mark. */
  bell: "M12 3.5a6.5 6.5 0 0 1 6.5 6.5c0 3.1.9 4.8 1.8 5.8H3.7c.9-1 1.8-2.7 1.8-5.8A6.5 6.5 0 0 1 12 3.5zM9.7 19.3a2.5 2.5 0 0 0 4.6 0",
  /** Ring waves drawn beside the bell in the logo lockup. */
  bellRingLeft: "M4.5 5.5A9.5 9.5 0 0 0 2.5 9",
  bellRingRight: "M19.5 5.5A9.5 9.5 0 0 1 21.5 9",
  check: "M4.5 12.5l5 5L19.5 7",
  /** Crescent moon with a drifting Z — snooze. */
  snooze: "M19 14.5A7.5 7.5 0 0 1 9.5 5a8 8 0 1 0 9.5 9.5zM14.5 4.5H19l-4.5 4.5H19",
  trash: "M4.5 6.5h15M9.5 6.5v-2h5v2M6.5 6.5l1 13.5h9l1-13.5M10 10.5v6M14 10.5v6",
  /** Counter-clockwise circular arrow — reopen. */
  reopen: "M5 8.5A8 8 0 1 1 4.2 14M4.5 3.5v5h5",
  /** Three sliders — settings. */
  sliders: "M4 6.5h8M16 6.5h4M4 12h3M11 12h9M4 17.5h11M19 17.5h1M14 4.5v4M7 10v4M17 15.5v4",
  /** Opposing horizontal arrows — swipe gestures. */
  swipe: "M7.5 7.5L3 12l4.5 4.5M16.5 7.5L21 12l-4.5 4.5M3 12h18",
  close: "M6 6l12 12M18 6L6 18",
  /** Downward chevron — section drawers rotate it when collapsed. */
  chevron: "M6 9.5l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  /** Lightning bolt — the fast preset. */
  bolt: "M13.5 3L5.5 13.5h5L9.5 21l8-10.5h-5l1-7.5z",
  /** Clock face — the hourly preset. */
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.5l3 2",
  /** Arrows collapsing inward — the shrink preset. */
  shrink: "M4 4l6.5 6.5M10.5 5.5v5h-5M20 20l-6.5-6.5M13.5 18.5v-5h5",
} as const;

export type IconName = keyof typeof iconPaths;
