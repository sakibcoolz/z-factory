import { describe, expect, it } from "vitest";
import { resolveLocalOwner } from "@/lib/auth/actor";
import { DomainError } from "@/lib/domain/errors";
import { assertSubnetFree, cidrsOverlap, suggestSubnet } from "@/lib/validation/network";
import { readFactoryForm, toErrorMessage, toFormState } from "./form-state";
import { formatUtc } from "./format";

const values = { name: "Pump House", slug: "pump-house", description: "", subnetCidr: "172.20.1.0/24" };

describe("owner resolution (ADR-0007)", () => {
  it("uses the configured owner in every environment", () => {
    expect(resolveLocalOwner({ nodeEnv: "production", localOwnerId: "plant-a" })).toEqual({ ownerId: "plant-a" });
    expect(resolveLocalOwner({ nodeEnv: "development", localOwnerId: "plant-a" })).toEqual({ ownerId: "plant-a" });
  });

  it("falls back to the development owner outside production", () => {
    expect(resolveLocalOwner({ nodeEnv: "development", localOwnerId: undefined })).toEqual({ ownerId: "local-owner" });
    expect(resolveLocalOwner({ nodeEnv: "test", localOwnerId: undefined })).toEqual({ ownerId: "local-owner" });
  });

  it("refuses to run unowned in production", () => {
    expect(() => resolveLocalOwner({ nodeEnv: "production", localOwnerId: undefined })).toThrowError(
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    );
  });
});

describe("factory subnets", () => {
  it("detects containment in either direction, not just equality", () => {
    expect(cidrsOverlap("172.20.1.0/24", "172.20.1.0/24")).toBe(true);
    expect(cidrsOverlap("172.20.0.0/16", "172.20.1.0/24")).toBe(true);
    expect(cidrsOverlap("172.20.1.0/24", "172.20.0.0/16")).toBe(true);
    expect(cidrsOverlap("172.20.1.128/25", "172.20.1.0/24")).toBe(true);
    expect(cidrsOverlap("172.20.1.0/24", "172.20.2.0/24")).toBe(false);
    expect(cidrsOverlap("10.0.0.0/16", "192.168.0.0/16")).toBe(false);
  });

  it("rejects a subnet that overlaps an existing factory", () => {
    expect(() => assertSubnetFree("172.20.0.0/16", ["172.20.5.0/24"])).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(() => assertSubnetFree("172.21.0.0/16", ["172.20.5.0/24"])).not.toThrow();
  });

  it("suggests the first free /24", () => {
    expect(suggestSubnet([])).toBe("172.20.1.0/24");
    expect(suggestSubnet(["172.20.1.0/24", "172.20.2.0/25"])).toBe("172.20.3.0/24");
    expect(suggestSubnet(["172.20.0.0/16"])).toBeUndefined();
  });
});

describe("factory form state", () => {
  it("reads only string fields from the form", () => {
    const form = new FormData();
    form.set("name", "Pump House");
    form.set("slug", new File(["x"], "x.txt"));
    expect(readFactoryForm(form)).toEqual({ name: "Pump House", slug: "", description: "", subnetCidr: "" });
  });

  it("puts schema issues on their fields", () => {
    const error = new DomainError("VALIDATION", "subnetCidr: bad", {
      issues: [
        { path: "subnetCidr", message: "Use a private range." },
        { path: "slug", message: "Use lowercase letters." },
        { path: "subnetCidr", message: "second issue is ignored" },
      ],
    });
    expect(toFormState(error, values)).toEqual({
      message: undefined,
      fieldErrors: { subnetCidr: "Use a private range.", slug: "Use lowercase letters." },
      values,
    });
  });

  it("puts constraint conflicts on the field they belong to", () => {
    const slug = new DomainError("CONFLICT", "A factory with this slug already exists.", {
      constraint: "Factory_slug_key",
    });
    expect(toFormState(slug, values).fieldErrors).toEqual({ slug: "A factory with this slug already exists." });

    const overlap = new DomainError("CONFLICT", "This subnet overlaps the network of another factory.", {
      field: "subnetCidr",
    });
    expect(toFormState(overlap, values).fieldErrors.subnetCidr).toMatch(/overlaps/);
  });

  it("uses a form message for domain errors without a field", () => {
    const state = toFormState(new DomainError("NOT_FOUND", "The factory does not exist."), values);
    expect(state).toEqual({ message: "The factory does not exist.", fieldErrors: {}, values });
  });

  it("never shows internal error text", () => {
    const internal = new Error('connect ECONNREFUSED 127.0.0.1:5432 password "secret"');
    expect(toFormState(internal, values).message).toBe("Something went wrong. Nothing was saved; try again.");
    expect(toErrorMessage(internal)).not.toContain("secret");
  });
});

describe("timestamps", () => {
  it("formats ISO timestamps as stable UTC text", () => {
    expect(formatUtc("2026-10-04T17:20:23.000Z")).toBe("2026-10-04 17:20 UTC");
  });
});
