import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { DomainError } from "@/lib/domain/errors";
import { getServerEnv } from "@/lib/env";

/**
 * Z-Factory's own storage for catalog 3D assets (ADR-0012): a directory on the server.
 * Files are written once per asset version and never changed. Keys are made by the
 * server; no key or path ever comes from a request.
 */

export type AssetStorage = {
  put(key: string, bytes: Uint8Array): Promise<void>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
};

const KEY = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** `models/<model id>/v<version>/model.glb` */
export function modelAssetKey(deviceModelId: string, version: number): string {
  return `models/${deviceModelId.toLowerCase()}/v${version}/model.glb`;
}

export function createFileAssetStorage(root: string): AssetStorage {
  const base = resolve(root);
  const locate = (key: string): string => {
    const path = resolve(base, key);
    // A key is a plain relative path inside the storage directory, whoever made it.
    if (!KEY.test(key) || !path.startsWith(base + sep)) {
      throw new DomainError("INVARIANT", "The asset key is not valid.", { rule: "asset-key" });
    }
    return path;
  };

  return {
    async put(key, bytes) {
      const path = locate(key);
      await mkdir(dirname(path), { recursive: true });
      // Written beside its place and moved in, so a reader never sees half a file.
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async read(key) {
      try {
        return await readFile(locate(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new DomainError("NOT_FOUND", "The asset file is missing from storage.", { rule: "asset-file-missing" });
        }
        throw error;
      }
    },
    async remove(key) {
      await rm(locate(key), { force: true });
    },
  };
}

/** The asset storage of this server, from `ASSET_STORAGE_DIR`. */
export function getAssetStorage(): AssetStorage {
  return createFileAssetStorage(getServerEnv().ASSET_STORAGE_DIR);
}
