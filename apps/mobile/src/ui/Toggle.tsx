import { colors } from "@alarmed/ui";
import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet } from "react-native";

interface ToggleProps {
  value: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

/**
 * Custom animated switch matching the web app's .switch control — ember
 * track when on, sliding knob — instead of the platform-styled RN Switch.
 */
export function Toggle({ value, onChange, label, disabled }: ToggleProps) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: value ? 1 : 0,
      duration: 160,
      useNativeDriver: false,
    }).start();
  }, [value, anim]);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={styles.hit}
    >
      <Animated.View
        style={[
          styles.track,
          {
            backgroundColor: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [colors.surfaceRaised, colors.accent],
            }),
            borderColor: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [colors.border, colors.accent],
            }),
          },
        ]}
      >
        <Animated.View
          style={[
            styles.knob,
            {
              transform: [
                {
                  translateX: anim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 20],
                  }),
                },
              ],
              backgroundColor: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [colors.textSecondary, "#FFFFFF"],
              }),
            },
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: {
    padding: 4,
  },
  track: {
    width: 48,
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: "center",
  },
  knob: {
    width: 20,
    height: 20,
    borderRadius: 10,
    marginLeft: 3,
  },
});
