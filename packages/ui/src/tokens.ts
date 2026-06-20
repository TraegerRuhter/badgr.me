/**
 * Plain-object design tokens. Deliberately framework-free (no JSX, no
 * react-native-web) so both the Expo app and the Vite PWA can import the
 * same values without needing a shared component-rendering layer yet.
 */
export const colors = {
  background: "#F2F2F7",
  surface: "#FFFFFF",
  textPrimary: "#000000",
  textSecondary: "#6B6B6F",
  accent: "#34A853",
  danger: "#D92D20",
  border: "#D8D8DC",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const typography = {
  title: { fontSize: 17, fontWeight: "600" },
  body: { fontSize: 15, fontWeight: "400" },
  caption: { fontSize: 13, fontWeight: "400" },
} as const;
