-- TASK-603: the shipped module types are simulated by the process models of the same
-- name (TASK-602). The column was reserved for this ("null until one exists"); setting it
-- on the stored version is the one change a stored type version takes, because roles,
-- signals and settings stay as they are and nothing bound to them moves.
UPDATE "ProcessModuleType"
SET "simulatorModelType" = "code", "updatedAt" = NOW()
WHERE "code" IN ('PUMP_HOUSE', 'TANK') AND "version" = 1 AND "simulatorModelType" IS NULL;
