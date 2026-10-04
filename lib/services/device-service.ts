import "server-only";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { deviceRepository } from "@/lib/db/repositories/device-repository";
import { PLC_CATEGORY_CODE } from "@/lib/domain/device";
import { DomainError } from "@/lib/domain/errors";
import { parseInput } from "@/lib/validation/parse";
import { assertModelArchitecture } from "@/lib/validation/plc-architecture";
import { deviceInstanceInputSchema } from "@/lib/validation/schemas";

/**
 * Creates a factory-specific device instance from a reusable catalog model.
 * The instance name is unique within its factory; a PLC also gets its instance profile.
 */
export async function createDeviceInstance(db: PrismaClient, input: unknown) {
  const data = parseInput(deviceInstanceInputSchema, input);

  const model = await deviceRepository.findModel(db, data.deviceModelId);
  if (!model) throw new DomainError("NOT_FOUND", "The catalog model does not exist.", { field: "deviceModelId" });
  if (!(await deviceRepository.factoryExists(db, data.factoryId))) {
    throw new DomainError("NOT_FOUND", "The factory does not exist.", { field: "factoryId" });
  }

  const category = model.family.category;
  assertModelArchitecture({ categoryCode: category.code, architectureType: model.architectureType });

  return db.$transaction(async (transaction) => {
    const instance = await deviceRepository.createInstance(transaction, {
      ...data,
      runtimeType: model.runtimeSupport,
      simulatorType: category.simulatorType,
    });
    if (category.code === PLC_CATEGORY_CODE) {
      await deviceRepository.createPlcProfile(transaction, instance.id);
    }
    return instance;
  });
}
