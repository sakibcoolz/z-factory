import "server-only";

/** Labels that mark Docker resources as created by Z-Factory. */
export const LABEL_MANAGED = "zfactory.managed";
export const LABEL_FACTORY_ID = "zfactory.factory-id";
export const LABEL_DEVICE_ID = "zfactory.device-id";
export const LABEL_SERVICE = "zfactory.service";

export function isManaged(labels: Record<string, string> | undefined | null): boolean {
  return labels?.[LABEL_MANAGED] === "true";
}
