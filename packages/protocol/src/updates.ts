/**
 * Checking a GitHub release feed for a newer build.
 *
 * Shared by the CLI, the hub and the phone app so "is there a new version?"
 * means the same thing everywhere, and so the comparison rules live in one
 * tested place rather than three approximations.
 */

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  /** Tag with any leading `v` removed, e.g. `0.2.0`. */
  version: string;
  tag: string;
  notes: string;
  url: string;
  prerelease: boolean;
  publishedAt: number;
  assets: ReleaseAsset[];
}

export interface UpdateCheck {
  current: string;
  latest?: ReleaseInfo;
  /** True only when `latest` is genuinely newer than `current`. */
  available: boolean;
}

export interface CheckOptions {
  /** `owner/repo` on github.com. */
  repository: string;
  currentVersion: string;
  /**
   * Include prereleases. The rolling `latest` build is a prerelease, so this
   * is what separates "track every push to main" from "tagged versions only".
   */
  includePrerelease?: boolean;
  /**
   * When this build was produced, as epoch milliseconds.
   *
   * The rolling build is published under a fixed `latest` tag, which carries
   * no version to compare against - so for those the only meaningful question
   * is whether the release is newer than the binary asking.
   */
  currentBuiltAt?: number;
  timeoutMs?: number;
  /** Override for tests, or for a mirror. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Compares two dotted versions numerically.
 *
 * String comparison gets this wrong in the way that matters most: `"0.10.0" <
 * "0.9.0"` is true alphabetically, which would silently stop offering updates
 * exactly when a project reaches its tenth minor release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      // A prerelease suffix is dropped for ordering; `available` is decided by
      // the numeric part, and equal numbers mean "not newer".
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** True when a tag looks like a version rather than a moving label. */
export function looksVersioned(tag: string): boolean {
  return /^v?\d+(\.\d+)*/.test(tag.trim());
}

/** Fetches the newest release, or undefined when the feed cannot be read. */
export async function checkForUpdate(options: CheckOptions): Promise<UpdateCheck> {
  const {
    repository,
    currentVersion,
    includePrerelease = false,
    timeoutMs = 10_000,
    endpoint = `https://api.github.com/repos/${repository}/releases`,
    fetchImpl = fetch,
  } = options;

  const current = currentVersion.replace(/^v/, '');

  try {
    const response = await fetchImpl(`${endpoint}?per_page=20`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { current, available: false };

    const releases = (await response.json()) as GithubRelease[];
    const candidates = releases
      .filter((r) => !r.draft)
      .filter((r) => includePrerelease || !r.prerelease)
      .map(toReleaseInfo)
      // Newest first by version, not by publish order: a patch to an older
      // line can be published after a newer release.
      .sort((a, b) => compareVersions(b.version, a.version));

    // A moving tag like `latest` sorts to nothing useful, so pick the newest
    // by publish time among those and compare that way instead.
    const versioned = candidates.filter((r) => looksVersioned(r.tag));
    const moving = candidates
      .filter((r) => !looksVersioned(r.tag))
      .sort((a, b) => b.publishedAt - a.publishedAt);

    const latestVersioned = versioned[0];
    const latestMoving = includePrerelease ? moving[0] : undefined;

    if (latestMoving && options.currentBuiltAt) {
      const movingIsNewer = latestMoving.publishedAt > options.currentBuiltAt;
      const versionedIsNewer =
        latestVersioned && isNewer(latestVersioned.version, current);

      // Prefer a real version when one is genuinely newer; otherwise the
      // rolling build is the only thing on offer.
      if (!versionedIsNewer && movingIsNewer) {
        return { current, latest: latestMoving, available: true };
      }
    }

    const latest = latestVersioned ?? candidates[0];
    if (!latest) return { current, available: false };

    return { current, latest, available: isNewer(latest.version, current) };
  } catch {
    // A failed check is not an error worth surfacing: the app works fine on
    // the version it has, and the network may simply be unavailable.
    return { current, available: false };
  }
}

interface GithubRelease {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets?: { name: string; browser_download_url: string; size: number }[];
}

function toReleaseInfo(r: GithubRelease): ReleaseInfo {
  return {
    version: r.tag_name.replace(/^v/, ''),
    tag: r.tag_name,
    notes: r.body ?? '',
    url: r.html_url,
    prerelease: r.prerelease,
    publishedAt: Date.parse(r.published_at) || 0,
    assets: (r.assets ?? []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    })),
  };
}

/**
 * Picks the asset matching a platform, e.g. `notifyjs-linux-x64.tar.gz` or the
 * Android APK. Returns undefined rather than guessing.
 */
export function findAsset(release: ReleaseInfo, pattern: RegExp): ReleaseAsset | undefined {
  return release.assets.find((a) => pattern.test(a.name));
}
