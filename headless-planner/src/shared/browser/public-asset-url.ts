// Node.js adaptation: replaces Vite import.meta.env.BASE_URL with a simple fallback.
// In the headless planner, asset URLs are purely cosmetic strings and not fetched.

const URL_SCHEME_PATTERN = /^[a-z][a-z\d+\-.]*:/i;

export function createPublicAssetUrl(path: string): string {
  if (URL_SCHEME_PATTERN.test(path) || path.startsWith("//")) {
    return path;
  }

  const normalizedPath = path.replace(/^\/+/, "");
  return `/${normalizedPath}`;
}

export function createDeviceIconAssetUrl(entityId: string): string {
  return createPublicAssetUrl(`device-icons/${entityId}.webp`);
}

export function createItemIconAssetUrl(iconId: string): string {
  return createPublicAssetUrl(`item-icons/${iconId}.webp`);
}

export function isRootPublicAssetBaseUrl(): boolean {
  return false;
}
