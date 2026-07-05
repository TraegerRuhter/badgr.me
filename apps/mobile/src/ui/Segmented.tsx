import { colors, radii } from "@alarmed/ui";
import { Pressable, StyleSheet, Text, View } from "react-native";

interface SegmentedProps<T extends string> {
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  label: string;
  onChange: (next: T) => void;
}

/**
 * Custom segmented control matching the web app's .segmented — ember pill on
 * the active option.
 */
export function Segmented<T extends string>({
  options,
  labels,
  value,
  label,
  onChange,
}: SegmentedProps<T>) {
  return (
    <View style={styles.track} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((option) => {
        const active = option === value;
        return (
          <Pressable
            key={option}
            accessibilityRole="radio"
            accessibilityState={{ checked: active }}
            onPress={() => onChange(option)}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.text, active && styles.textActive]}>
              {labels[option]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
  },
  segment: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: radii.pill,
    alignItems: "center",
  },
  segmentActive: {
    backgroundColor: colors.accent,
  },
  text: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.1,
    color: colors.textSecondary,
  },
  textActive: {
    color: colors.onAccent,
  },
});
