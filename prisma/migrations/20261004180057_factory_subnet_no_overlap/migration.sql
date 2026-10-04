-- Each factory owns one Docker network on a shared host, so factory subnets must not
-- overlap (not merely differ). `&&` on inet is "contains or is contained by".
-- Listed in docs/database.md -> Database-enforced invariants.
ALTER TABLE "Factory" ADD CONSTRAINT "Factory_subnet_no_overlap"
  EXCLUDE USING gist (("subnetCidr"::inet) inet_ops WITH &&);
