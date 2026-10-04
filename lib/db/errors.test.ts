import { describe, expect, it } from "vitest";
import { toDomainError, withDomainErrors } from "./errors";

/** Shapes observed from Prisma 7 with the pg driver adapter. */
const prismaError = (code: string, cause: Record<string, unknown> = {}) => ({
  code,
  meta: { driverAdapterError: { cause } },
});

describe("database error translation", () => {
  it("maps a known unique constraint to its domain message", () => {
    const error = toDomainError(prismaError("P2002", { constraint: { index: "DeviceInstance_factoryId_name_key" } }));
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toBe("A device with this name already exists in the factory.");
  });

  it("reads CHECK and EXCLUDE constraint names from the driver message", () => {
    const check = toDomainError(
      prismaError("P2039", {
        originalCode: "23514",
        originalMessage: 'new row for relation "Tag" violates check constraint "Tag_writable_role_check"',
      }),
    );
    expect(check?.code).toBe("INVARIANT");

    const exclusion = toDomainError(
      prismaError("P2039", {
        originalCode: "23P01",
        originalMessage: 'conflicting key value violates exclusion constraint "DeviceConnection_one_motor_per_drive"',
      }),
    );
    expect(exclusion?.code).toBe("INVARIANT");
    expect(exclusion?.details.constraint).toBe("DeviceConnection_one_motor_per_drive");
  });

  it("falls back by error class for unknown constraints", () => {
    expect(toDomainError(prismaError("P2002", { constraint: { index: "Other_key" } }))?.code).toBe("CONFLICT");
    expect(toDomainError(prismaError("P2025"))?.code).toBe("NOT_FOUND");
    expect(toDomainError(prismaError("P2039", { originalCode: "23514" }))?.code).toBe("VALIDATION");
    expect(
      toDomainError(prismaError("P2003", { originalMessage: "update or delete on table violates foreign key" }))?.code,
    ).toBe("CONFLICT");
    expect(
      toDomainError(prismaError("P2003", { originalMessage: "insert or update on table violates foreign key" }))?.code,
    ).toBe("NOT_FOUND");
  });

  it("never copies driver text into the domain message", () => {
    const error = toDomainError(
      prismaError("P2039", {
        originalCode: "23514",
        originalMessage: 'violates check constraint "Unknown_check"',
        detail: "Failing row contains (secret-value).",
      }),
    );
    expect(error?.message).toBe("The values violate a data rule.");
    expect(JSON.stringify(error?.details)).not.toContain("secret-value");
  });

  it("leaves unrelated errors alone", async () => {
    expect(toDomainError(new Error("boom"))).toBeUndefined();
    const boom = new Error("boom");
    await expect(withDomainErrors(() => Promise.reject(boom))).rejects.toBe(boom);
  });
});
