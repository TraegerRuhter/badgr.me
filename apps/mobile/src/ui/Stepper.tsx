import { colors, radii } from "@alarmed/ui";
import { Pressable, StyleSheet, Text, View } from "react-native";

interface StepperProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label: string;
  onChange: (next: number) => void;
}

/**
 * Custom − / value / + control matching the web app's .stepper — for the
 * numeric fine-tuning knobs in Settings.
 */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  unit,
  label,
  onChange,
}: StepperProps) {
  const atMin = value <= min;
  const atMax = value >= max;
  return (
    <View style={styles.track} accessibilityLabel={label}>
      <Pressable
        accessibilityLabel={`Decrease ${label}`}
        disabled={atMin}
        onPress={() => onChange(Math.max(min, value - step))}
        style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
      >
        <Text style={[styles.btnText, atMin && styles.btnTextDisabled]}>−</Text>
      </Pressable>
      <View style={styles.valueBox}>
        <Text style={styles.value}>
          {value}
          {unit ? <Text style={styles.unit}>{unit}</Text> : null}
        </Text>
      </View>
      <Pressable
        accessibilityLabel={`Increase ${label}`}
        disabled={atMax}
        onPress={() => onChange(Math.min(max, value + step))}
        style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
      >
        <Text style={[styles.btnText, atMax && styles.btnTextDisabled]}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
    overflow: "hidden",
  },
  btn: {
    width: 32,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPressed: {
    backgroundColor: colors.accentSoft,
  },
  btnText: {
    fontSize: 17,
    fontWeight: "700",
    color: colors.textPrimary,
    lineHeight: 20,
  },
  btnTextDisabled: {
    color: colors.border,
  },
  valueBox: {
    minWidth: 44,
    alignItems: "center",
  },
  value: {
    fontSize: 13.5,
    fontWeight: "700",
    color: colors.accent,
    fontVariant: ["tabular-nums"],
  },
  unit: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.textSecondary,
  },
});
