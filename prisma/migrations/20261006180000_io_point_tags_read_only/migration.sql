-- TASK-205 / ADR-0015: a tag on a PLC I/O point is the program's local I/O. It is never
-- externally writable: the scan cycle owns outputs, the field (or the simulation bridge)
-- owns inputs. Command and setpoint memory lives on addresses that are not I/O points.
ALTER TABLE "Tag"
  ADD CONSTRAINT "Tag_io_point_read_only_check"
  CHECK ("plcIoPointId" IS NULL OR "accessMode" = 'READ_ONLY');
