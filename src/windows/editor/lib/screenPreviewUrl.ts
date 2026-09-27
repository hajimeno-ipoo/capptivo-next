/**
 * Interactive editor preview URL: use the original recording so small text
 * remains as detailed as the captured frames.
 */
export function screenPreviewUrl(
  proxyUrl: string | null,
  screenUrl: string | null,
): string | null {
  return screenUrl ?? proxyUrl;
}
