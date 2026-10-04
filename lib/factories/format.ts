/** Stable UTC timestamp for server-rendered text, e.g. `2026-10-04 17:20 UTC`. */
export function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
