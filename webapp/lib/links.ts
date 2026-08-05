// ---------------------------------------------------------------------------
// Every URL that leaves this site, in one place.
//
// It lives here because the site shipped with `href="#"` on GitHub, README,
// License and both social links, and three download buttons that were `<button>`
// elements wired to nothing. A dead link on a download page is worse than no
// button: it reads as a broken product rather than a missing page.
//
// THE VERSION IS LOAD-BEARING. electron-builder puts the version INTO every
// artifact filename (`Jarvis-Setup-0.3.0-x64.exe`), so there is no stable
// "latest" filename to point at — GitHub's /releases/latest/download/<name>
// still needs the exact name. That means these links go stale on the next
// release, silently, returning 404 to anyone who clicks them.
//
// So the root test suite asserts VERSION matches the app's package.json
// (see webapp-links.test.mjs). Bump one without the other and `npm test` fails
// rather than the download page.
// ---------------------------------------------------------------------------

/** Must equal the `version` in the repository-root package.json. */
export const VERSION = "0.10.0";

export const REPO_URL = "https://github.com/Ashutosh0x/jarvis";
export const NPM_URL = "https://www.npmjs.com/package/@ashutosh0x/jarvis";
export const NPM_PACKAGE = "@ashutosh0x/jarvis";

export const RELEASES_URL = `${REPO_URL}/releases`;
export const RELEASE_URL = `${RELEASES_URL}/tag/v${VERSION}`;
export const README_URL = `${REPO_URL}#readme`;
export const LICENSE_URL = `${REPO_URL}/blob/master/LICENSE`;
export const ISSUES_URL = `${REPO_URL}/issues`;
/** Published with the release; verifies any download above. */
export const CHECKSUMS_URL = `${RELEASES_URL}/download/v${VERSION}/SHA256SUMS`;

const asset = (file: string) => `${RELEASES_URL}/download/v${VERSION}/${file}`;

export type PlatformId = "windows" | "macos" | "linux";

export interface DownloadTarget {
  /** Shown on the button. */
  label: string;
  href: string;
  /** Approximate download size, from the published release. */
  size: string;
  primary?: boolean;
}

export interface Platform {
  id: PlatformId;
  name: string;
  /** What the user needs to be running. Stated, not implied. */
  requirement: string;
  downloads: DownloadTarget[];
}

/**
 * Filenames come from electron-builder's artifactName templates in
 * electron-builder.yml. Anything listed here is a file the release workflow
 * actually produces.
 *
 * The sizes were measured on the v0.3.0 release rather than estimated, and are
 * carried forward: 0.4.0 adds the 90 KB scrcpy server jar and the mirror
 * modules, which does not move a 122 MB installer by a displayed digit. They
 * are labelled approximate on the page for that reason — re-measure them when a
 * release changes what is bundled, not on every bump.
 */
export const PLATFORMS: Platform[] = [
  {
    id: "windows",
    name: "Windows",
    requirement: "Windows 10 or 11, 64-bit",
    downloads: [
      {
        label: "Installer",
        href: asset(`Jarvis-Setup-${VERSION}-x64.exe`),
        size: "122 MB",
        primary: true,
      },
      { label: "Portable", href: asset(`Jarvis-Portable-${VERSION}-x64.exe`), size: "122 MB" },
      { label: "Zip", href: asset(`Jarvis-${VERSION}-x64.zip`), size: "164 MB" },
    ],
  },
  {
    id: "macos",
    name: "macOS",
    // One download for both architectures, which is the point of shipping
    // universal — nobody has to know which Mac they own.
    requirement: "Apple Silicon and Intel, universal",
    downloads: [
      { label: "Disk image", href: asset(`Jarvis-${VERSION}-universal.dmg`), size: "236 MB", primary: true },
      { label: "Zip", href: asset(`Jarvis-${VERSION}-universal.zip`), size: "226 MB" },
    ],
  },
  {
    id: "linux",
    name: "Linux",
    requirement: "x86_64 — AppImage, deb or rpm",
    downloads: [
      { label: "AppImage", href: asset(`Jarvis-${VERSION}-x86_64.AppImage`), size: "162 MB", primary: true },
      { label: ".deb", href: asset(`Jarvis-${VERSION}-amd64.deb`), size: "111 MB" },
      { label: ".rpm", href: asset(`Jarvis-${VERSION}-x86_64.rpm`), size: "111 MB" },
      { label: "tar.gz", href: asset(`Jarvis-${VERSION}-x64.tar.gz`), size: "152 MB" },
    ],
  },
];
