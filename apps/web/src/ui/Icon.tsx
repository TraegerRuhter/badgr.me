import { iconPaths, type IconName } from "@alarmed/ui";

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/**
 * Renders one of the shared hand-drawn 24×24 stroke icons from @alarmed/ui.
 * `currentColor` by default so buttons tint their icon with their text color.
 */
export function Icon({
  name,
  size = 18,
  color = "currentColor",
  strokeWidth = 2,
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}
