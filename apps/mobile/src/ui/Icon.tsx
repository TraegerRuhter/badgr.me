import { iconPaths, type IconName } from "@alarmed/ui";
import Svg, { Path } from "react-native-svg";

interface IconProps {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}

/**
 * Renders one of the shared hand-drawn 24×24 stroke icons from @alarmed/ui —
 * the native counterpart to apps/web/src/ui/Icon.tsx, same path data.
 */
export function Icon({ name, size = 18, color, strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d={iconPaths[name]}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
