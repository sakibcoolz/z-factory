/**
 * Last line of defence for exports (docs/plc-export.md → Security): an export is built
 * from fields that are safe by construction, and this check still refuses to hand out a
 * document in which a secret, a Docker detail or a host path turned up. Pure.
 */

const FORBIDDEN_KEY =
  /(password|passwd|secret|token|credential|api[-_]?key|private[-_]?key|container[-_]?id|docker[-_]?host)/i;

const FORBIDDEN_VALUE: ReadonlyArray<readonly [RegExp, string]> = [
  [/docker\.sock/i, "the Docker socket"],
  [/\bunix:\/\//i, "a unix socket address"],
  [/\btcp:\/\/[^\s]+:\d+/i, "a Docker TCP endpoint"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/^\/(var|home|root|etc|usr|opt|mnt|tmp|srv|run)\//, "a host path"],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/, "a bearer token"],
];

export type SensitiveFinding = { path: string; reason: string };

/** Every place in a value where something that must not be exported was found. */
export function findSensitive(value: unknown, path = "$"): SensitiveFinding[] {
  if (typeof value === "string") {
    const hit = FORBIDDEN_VALUE.find(([pattern]) => pattern.test(value));
    return hit ? [{ path, reason: hit[1] }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => findSensitive(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [
      ...(FORBIDDEN_KEY.test(key)
        ? [{ path: `${path}.${key}`, reason: "a field that names a secret or a Docker detail" }]
        : []),
      ...findSensitive(child, `${path}.${key}`),
    ]);
  }
  return [];
}
