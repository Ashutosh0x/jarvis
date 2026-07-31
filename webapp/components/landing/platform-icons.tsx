// Platform marks for the download section.
//
// Written out rather than taken from lucide-react, which has no brand logos:
// its `Apple` icon is a piece of FRUIT with a leaf, which above a macOS
// download button reads as a mistake. These are the real marks, monochrome,
// on a 24x24 grid, filled rather than stroked so they stay legible at 20px.
//
// `currentColor` throughout, so they inherit the surrounding text colour and
// work in both the light and dark themes without a second copy.

interface IconProps {
  className?: string;
}

/** The four-pane Windows mark. */
export function WindowsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  );
}

/** The Apple mark. Nominative use, identifying the platform of a download. */
export function AppleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.088-4.61 1.088zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

/**
 * Tux.
 *
 * Drawn here rather than copied, and `evenodd` is doing real work: the belly,
 * eyes and beak are subpaths CUT OUT of the silhouette rather than painted
 * white over it. A white-on-black penguin would disappear against a dark
 * background — cutting the holes means one mark renders correctly in both
 * themes, which was checked by rasterising it on each.
 */
export function LinuxIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M12 1.6c-2.4 0-4 1.8-4 4.4 0 1.2.2 1.9-.4 2.8-1.4 2-2.4 4.8-2.4 7.6 0 3 1.4 5.2 3.2 5.8 1 .35 2.2.5 3.6.5s2.6-.15 3.6-.5c1.8-.6 3.2-2.8 3.2-5.8 0-2.8-1-5.6-2.4-7.6-.6-.9-.4-1.6-.4-2.8 0-2.6-1.6-4.4-4-4.4z M12 10.2c-2.4 0-3.8 2.4-3.8 6 0 3 1.5 4.8 3.8 4.8s3.8-1.8 3.8-4.8c0-3.6-1.4-6-3.8-6z M10.35 3.9a1.15 1.5 0 1 0 .01 0z M13.65 3.9a1.15 1.5 0 1 0 .01 0z M10.5 4.6a.62.82 0 1 0 .01 0z M13.5 4.6a.62.82 0 1 0 .01 0z M12 6.35c-.85 0-1.5.5-1.5 1.1s.65 1.1 1.5 1.1 1.5-.5 1.5-1.1-.65-1.1-1.5-1.1z M8.6 21.6c-.5.9-1.6 1.3-2.7 1.1-.7-.15-.9-.6-.5-1.1.5-.65 1.5-1.15 2.4-1.15.6 0 1 .5.8 1.15z M15.4 21.6c.5.9 1.6 1.3 2.7 1.1.7-.15.9-.6.5-1.1-.5-.65-1.5-1.15-2.4-1.15-.6 0-1 .5-.8 1.15z"
      />
    </svg>
  );
}

export const PLATFORM_ICONS = {
  windows: WindowsIcon,
  macos: AppleIcon,
  linux: LinuxIcon,
} as const;
