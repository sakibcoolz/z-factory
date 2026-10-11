-- CreateEnum
CREATE TYPE "SimulationCoverage" AS ENUM ('FULL', 'PARTIAL', 'GENERIC', 'NOT_SIMULATABLE');

-- AlterTable
ALTER TABLE "DeviceModel" ADD COLUMN     "simulationCoverage" "SimulationCoverage" NOT NULL DEFAULT 'NOT_SIMULATABLE',
ADD COLUMN     "simulationJson" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "simulationProfile" TEXT,
ADD COLUMN     "simulationProfileVersion" INTEGER;

-- A simulated model names its profile and version; one that is not simulated names none.
ALTER TABLE "DeviceModel" ADD CONSTRAINT "DeviceModel_simulation_profile_check" CHECK (
  ("simulationCoverage" = 'NOT_SIMULATABLE' AND "simulationProfile" IS NULL AND "simulationProfileVersion" IS NULL)
  OR ("simulationCoverage" <> 'NOT_SIMULATABLE' AND "simulationProfile" IS NOT NULL AND "simulationProfileVersion" >= 1)
);
