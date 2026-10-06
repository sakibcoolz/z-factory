"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import type { LinkResult } from "@/lib/domain/topology-view";
import type { PairWiringView } from "@/lib/domain/wiring-view";
import { routes } from "@/lib/navigation/routes";
import {
  linkDevices,
  moveDevices,
  placeDevice,
  removeDevice,
  renameDevice,
  unlinkDevices,
} from "@/lib/services/topology-service";
import { connectWire, disconnectWire, getPairWiring, reconnectWire } from "@/lib/services/wiring-service";

/**
 * Designer canvas mutations. The canvas calls these directly, so each returns a result
 * instead of redirecting. They pass the authorization boundary first, validate in the
 * service, and change configuration only.
 */

export type CanvasResult<T = undefined> = { ok: true; value: T } | { ok: false; message: string };

const GENERIC_MESSAGE = "Something went wrong. Nothing was saved; try again.";

const CONSTRAINT_MESSAGE: Record<string, string> = {
  DeviceInstance_factoryId_name_key: "A device with this name already exists in this factory.",
};

async function run<T>(factoryId: string, action: string, work: () => Promise<T>): Promise<CanvasResult<T>> {
  try {
    const value = await work();
    revalidatePath(routes.factory(factoryId), "layout");
    return { ok: true, value };
  } catch (error) {
    if (!isDomainError(error)) {
      console.error(JSON.stringify({ level: "error", action, error: String(error) }));
      return { ok: false, message: GENERIC_MESSAGE };
    }
    const constraint = (error as DomainError).details.constraint;
    return { ok: false, message: (typeof constraint === "string" && CONSTRAINT_MESSAGE[constraint]) || error.message };
  }
}

export async function placeDeviceAction(
  factoryId: string,
  input: { deviceModelId: string; x: number; y: number },
): Promise<CanvasResult<{ id: string; name: string }>> {
  return run(factoryId, "designer.place", async () => placeDevice(getDb(), await requireActor(), factoryId, input));
}

export async function moveDevicesAction(
  factoryId: string,
  positions: Array<{ deviceId: string; x: number; y: number }>,
): Promise<CanvasResult> {
  return run(factoryId, "designer.move", async () => {
    await moveDevices(getDb(), await requireActor(), factoryId, positions);
    return undefined;
  });
}

export async function linkDevicesAction(
  factoryId: string,
  input: { fromId: string; toId: string; kind?: string },
): Promise<CanvasResult<LinkResult>> {
  return run(factoryId, "designer.link", async () => linkDevices(getDb(), await requireActor(), factoryId, input));
}

export async function unlinkDevicesAction(
  factoryId: string,
  input: { sourceId: string; targetId: string; relationship: string },
): Promise<CanvasResult> {
  return run(factoryId, "designer.unlink", async () => {
    await unlinkDevices(getDb(), await requireActor(), factoryId, input);
    return undefined;
  });
}

export async function removeDeviceAction(factoryId: string, deviceId: string): Promise<CanvasResult> {
  return run(factoryId, "designer.remove", async () => {
    await removeDevice(getDb(), await requireActor(), deviceId);
    return undefined;
  });
}

export async function renameDeviceAction(
  factoryId: string,
  deviceId: string,
  input: { name: string; role: string },
): Promise<CanvasResult> {
  return run(factoryId, "designer.rename", async () => {
    await renameDevice(getDb(), await requireActor(), deviceId, { name: input.name, role: input.role || undefined });
    return undefined;
  });
}

type WireInput = {
  from: { deviceId: string; type: string; id: string };
  to: { deviceId: string; type: string; id: string };
};

/** The endpoints of two devices and the wires between them. Reads only; nothing is revalidated. */
export async function loadPairWiringAction(
  factoryId: string,
  firstId: string,
  secondId: string,
  replacingWireId?: string,
): Promise<CanvasResult<PairWiringView>> {
  try {
    const value = await getPairWiring(getDb(), await requireActor(), factoryId, firstId, secondId, replacingWireId);
    return { ok: true, value };
  } catch (error) {
    if (isDomainError(error)) return { ok: false, message: error.message };
    console.error(JSON.stringify({ level: "error", action: "designer.wiring", error: String(error) }));
    return { ok: false, message: GENERIC_MESSAGE };
  }
}

export async function connectWireAction(
  factoryId: string,
  input: WireInput,
): Promise<CanvasResult<{ wireId: string }>> {
  return run(factoryId, "designer.wire", async () => connectWire(getDb(), await requireActor(), factoryId, input));
}

export async function reconnectWireAction(
  factoryId: string,
  wireId: string,
  input: WireInput,
): Promise<CanvasResult<{ wireId: string }>> {
  return run(factoryId, "designer.rewire", async () =>
    reconnectWire(getDb(), await requireActor(), factoryId, wireId, input),
  );
}

export async function disconnectWireAction(factoryId: string, wireId: string): Promise<CanvasResult> {
  return run(factoryId, "designer.unwire", async () => {
    await disconnectWire(getDb(), await requireActor(), factoryId, wireId);
    return undefined;
  });
}
