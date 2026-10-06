import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import { assetRepository } from "@/lib/db/repositories/asset-repository";
import { DomainError } from "@/lib/domain/errors";
import {
  type FactorySceneView,
  normalizeDegrees,
  SCENE_SCALE_RANGE,
  type SceneAssetView,
} from "@/lib/domain/scene-view";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { routes } from "@/lib/navigation/routes";
import { layoutFloor } from "@/lib/scene/layout";
import { placeholderFor } from "@/lib/scene/placeholders";
import { edgeLabel, edgeLine } from "@/lib/topology/flow";
import { parseInput } from "@/lib/validation/parse";
import { getTopology } from "./topology-service";

/**
 * The 3D view of a factory. It is built from the topology the designer and the 2D view
 * use: the same devices, the same connections, the same stored states, and each device
 * where it stands in the designer. The scene adds only what a renderer needs: the
 * catalog model's 3D asset and how the instance is turned and sized.
 */
export async function getFactoryScene(db: PrismaClient, actor: Actor, factoryId: string): Promise<FactorySceneView> {
  const topology = await getTopology(db, actor, factoryId);
  const placed = new Map((await assetRepository.listSceneDevices(db, factoryId)).map((device) => [device.id, device]));
  const { positions, extent } = layoutFloor(topology.nodes);

  return {
    factory: topology.factory,
    devices: topology.nodes.flatMap((node, index) => {
      const scene = placed.get(node.id);
      const position = positions[index];
      // A device removed between the two reads is simply not drawn.
      if (!scene || !position) return [];
      const stored = scene.deviceModel.active3dAsset;
      const asset: SceneAssetView | null =
        stored && stored.status === "READY"
          ? {
              id: stored.id,
              version: stored.version,
              url: routes.modelAsset(stored.id),
              scale: stored.scale,
              rotationYDeg: stored.rotationYDeg,
            }
          : null;
      return [
        {
          id: node.id,
          name: node.name,
          role: node.role,
          categoryCode: node.categoryCode,
          categoryName: node.categoryName,
          manufacturer: node.manufacturer,
          modelId: scene.deviceModel.id,
          modelName: node.modelName,
          isPlc: node.architectureType !== null,
          runtimeStatus: node.runtimeStatus,
          position,
          rotationDeg: scene.sceneRotationDeg,
          scale: scene.sceneScale,
          asset,
          placeholder: placeholderFor(node.categoryCode),
        },
      ];
    }),
    connections: topology.edges.map((edge) => ({
      id: edge.id,
      relationship: edge.relationship,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      line: edgeLine(edge.relationship),
      label: edgeLabel(edge),
      // Exactly the wires that are stored: a conductor is never inferred from the kind of device.
      conductors: edge.wires.map((wire) => ({ id: wire.id, kind: wire.kind, from: wire.from.name, to: wire.to.name })),
    })),
    extent,
  };
}

const transformSchema = z.object({
  rotationDeg: z.number().min(-3600).max(3600),
  scale: z.number().min(SCENE_SCALE_RANGE.min).max(SCENE_SCALE_RANGE.max),
});

/**
 * Turns or sizes one device in the 3D view. This is appearance only: it changes nothing
 * about the device, its connections or its state, and the designer's layout decides
 * where the device stands.
 */
export async function setDeviceSceneTransform(
  db: PrismaClient,
  actor: Actor,
  deviceId: string,
  input: unknown,
): Promise<{ rotationDeg: number; scale: number }> {
  const data = parseInput(transformSchema, input);
  const device = await assetRepository.findDeviceForOwner(db, actor.ownerId, deviceId);
  if (!device) throw new DomainError("NOT_FOUND", "The device does not exist.");
  const next = { sceneRotationDeg: normalizeDegrees(data.rotationDeg), sceneScale: data.scale };
  await assetRepository.setSceneTransform(db, device.id, next);
  return { rotationDeg: next.sceneRotationDeg, scale: next.sceneScale };
}

export type SceneTransformChange =
  { kind: "ROTATE"; byDeg: number } | { kind: "SCALE"; factor: number } | { kind: "RESET" };

/** One step from where the device is now: a turn, a change of size, or back to the asset's own. */
export async function changeDeviceSceneTransform(
  db: PrismaClient,
  actor: Actor,
  deviceId: string,
  change: SceneTransformChange,
): Promise<{ rotationDeg: number; scale: number }> {
  const device = await assetRepository.findDeviceForOwner(db, actor.ownerId, deviceId);
  if (!device) throw new DomainError("NOT_FOUND", "The device does not exist.");
  const clamp = (scale: number) => Math.min(SCENE_SCALE_RANGE.max, Math.max(SCENE_SCALE_RANGE.min, scale));
  const next =
    change.kind === "RESET"
      ? { rotationDeg: 0, scale: 1 }
      : change.kind === "ROTATE"
        ? { rotationDeg: device.sceneRotationDeg + change.byDeg, scale: device.sceneScale }
        : // Two decimals: repeated steps up and down come back to where they started.
          {
            rotationDeg: device.sceneRotationDeg,
            scale: Math.round(clamp(device.sceneScale * change.factor) * 100) / 100,
          };
  return setDeviceSceneTransform(db, actor, deviceId, next);
}
