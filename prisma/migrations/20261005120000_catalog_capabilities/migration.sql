-- CreateEnum
CREATE TYPE "ControlCapability" AS ENUM ('DIRECT_IO', 'PARAMETER_CONFIGURED', 'PROTOCOL_CONTROLLED', 'PROGRAMMABLE');

-- AlterTable
ALTER TABLE "BuiltInIoChannel" ADD COLUMN     "acceptedSignalTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "DeviceModel" ADD COLUMN     "controlCapability" "ControlCapability" NOT NULL DEFAULT 'DIRECT_IO';

-- AlterTable
ALTER TABLE "ModuleChannel" ADD COLUMN     "acceptedSignalTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];

