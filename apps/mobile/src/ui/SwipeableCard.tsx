import { colors, radii, type IconName } from "@alarmed/ui";
import { useMemo, useRef } from "react";
import { Animated, PanResponder, StyleSheet, View } from "react-native";

import { Icon } from "./Icon";

interface SwipeableCardProps {
  enabled: boolean;
  onSwipeRight: (() => void) | null;
  onSwipeLeft: (() => void) | null;
  rightIcon: IconName;
  leftIcon: IconName;
  children: React.ReactNode;
}

const THRESHOLD = 72;
const DIRECTION_LOCK = 10;
const MAX_PULL = 128;

/**
 * Horizontal swipe wrapper for a task card — the native counterpart to the
 * web app's useSwipe hook: direction-locked so vertical list scrolling stays
 * natural, resistance past the threshold, hint icons revealed underneath,
 * and a spring back to rest on release.
 */
export function SwipeableCard({
  enabled,
  onSwipeRight,
  onSwipeLeft,
  rightIcon,
  leftIcon,
  children,
}: SwipeableCardProps) {
  const offset = useRef(new Animated.Value(0)).current;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          enabled &&
          Math.abs(gesture.dx) > DIRECTION_LOCK &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderMove: (_evt, gesture) => {
          const actionable =
            gesture.dx > 0 ? onSwipeRight !== null : onSwipeLeft !== null;
          const give = actionable ? 1 : 0.15;
          offset.setValue(Math.tanh(gesture.dx / MAX_PULL) * MAX_PULL * give);
        },
        onPanResponderRelease: (_evt, gesture) => {
          if (gesture.dx > THRESHOLD && onSwipeRight) onSwipeRight();
          else if (gesture.dx < -THRESHOLD && onSwipeLeft) onSwipeLeft();
          Animated.spring(offset, {
            toValue: 0,
            useNativeDriver: true,
            speed: 20,
            bounciness: 4,
          }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(offset, {
            toValue: 0,
            useNativeDriver: true,
            speed: 20,
            bounciness: 4,
          }).start();
        },
      }),
    [enabled, onSwipeRight, onSwipeLeft, offset]
  );

  const rightOpacity = offset.interpolate({
    inputRange: [0, 64],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });
  const leftOpacity = offset.interpolate({
    inputRange: [-64, 0],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  return (
    <View style={styles.track}>
      <Animated.View
        pointerEvents="none"
        style={[styles.hint, styles.hintRight, { opacity: rightOpacity }]}
      >
        <Icon name={rightIcon} size={22} color={colors.accent} />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        style={[styles.hint, styles.hintLeft, { opacity: leftOpacity }]}
      >
        <Icon name={leftIcon} size={22} color={colors.textSecondary} />
      </Animated.View>
      <Animated.View
        {...responder.panHandlers}
        style={{ transform: [{ translateX: offset }] }}
      >
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    position: "relative",
    marginBottom: 10,
    borderRadius: radii.lg,
    overflow: "hidden",
  },
  hint: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: radii.lg,
    justifyContent: "center",
  },
  hintRight: {
    alignItems: "flex-start",
    paddingLeft: 22,
    backgroundColor: colors.accentSoft,
  },
  hintLeft: {
    alignItems: "flex-end",
    paddingRight: 22,
    backgroundColor: colors.surfaceRaised,
  },
});
