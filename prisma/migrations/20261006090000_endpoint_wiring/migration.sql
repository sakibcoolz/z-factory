-- CreateEnum
CREATE TYPE "TerminalKind" AS ENUM ('SIGNAL', 'POWER', 'COMMON', 'EARTH');

-- AlterEnum
ALTER TYPE "ConnectionRelationship" ADD VALUE 'WIRED_TO';

-- AlterTable
ALTER TABLE "CommunicationPort" ADD COLUMN     "maxConnections" INTEGER NOT NULL DEFAULT 16;

-- AlterTable
ALTER TABLE "DeviceIoDefinition" ADD COLUMN     "kind" "TerminalKind" NOT NULL DEFAULT 'SIGNAL',
ADD COLUMN     "maxConnections" INTEGER NOT NULL DEFAULT 1;


-- CHECK constraints are not part of the Prisma schema; keep this block in sync with
-- docs/database.md → Database-enforced invariants.
ALTER TABLE "DeviceIoDefinition" ADD CONSTRAINT "DeviceIoDefinition_max_connections_check" CHECK ("maxConnections" > 0);
ALTER TABLE "CommunicationPort" ADD CONSTRAINT "CommunicationPort_max_connections_check" CHECK ("maxConnections" > 0);
