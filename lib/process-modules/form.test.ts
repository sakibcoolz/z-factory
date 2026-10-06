import { describe, expect, it } from "vitest";
import { configFields, formField } from "@/lib/process-modules/form";

describe("module form fields", () => {
  it("types each setting by its declared kind and leaves empty ones to the default", () => {
    const data = new FormData();
    data.set("name", " PH-01 ");
    data.set("config.ratedFlow", "60");
    data.set("configType.ratedFlow", "number");
    data.set("config.stages", "3");
    data.set("configType.stages", "integer");
    data.set("config.heated", "false");
    data.set("configType.heated", "boolean");
    data.set("config.duty", "CONTINUOUS");
    data.set("configType.duty", "choice");
    data.set("config.ratedPressure", "");
    data.set("configType.ratedPressure", "number");
    data.set("$ACTION_ID_1", "ignored");
    expect(formField(data, "name")).toBe("PH-01");
    expect(formField(data, "missing")).toBe("");
    expect(configFields(data)).toEqual({ ratedFlow: 60, stages: 3, heated: false, duty: "CONTINUOUS" });
  });
});
