import type { Jsonify } from "./types";

/** A server value as the browser will see it, for a client component's first render. */
export function toJson<T>(value: T): Jsonify<T> {
  return JSON.parse(JSON.stringify(value)) as Jsonify<T>;
}
