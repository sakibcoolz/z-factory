// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { inspectGlb } from "@/lib/assets/glb";
import { createMeshyProvider, estimateCredits, type GenerationRequest } from "@/lib/assets/meshy";
import { MAX_ASSET_TRIANGLES, normalizeGlb, readGlb } from "@/lib/assets/normalize";
import { assertGenericPrompt, buildAssetPrompt, MAX_PROMPT_CHARS, type PromptModel } from "@/lib/assets/prompt";
import { loadCatalog } from "@/lib/catalog";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import { DomainError } from "@/lib/domain/errors";
import { parseServerEnv } from "@/lib/env";
import { placeholderFor } from "@/lib/scene/placeholders";
import { makeBoxGlb } from "@/test/glb";

/**
 * The authoring path of catalog 3D assets without a database: the prompt a model's asset
 * is generated from, what normalization does to a file, how the provider is spoken to,
 * and where the provider may be used from.
 */

const rule = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? error.details.rule : error;
  }
  return undefined;
};

const close = (actual: readonly number[], expected: readonly number[]) =>
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index] ?? NaN, 5));

/** Where a point of the file ends up in the normalized scene. */
function placed(bytes: Uint8Array, point: readonly [number, number, number]): number[] {
  const { gltf } = readGlb(bytes);
  const nodes = gltf.nodes as Array<{ matrix?: number[]; children?: number[] }>;
  const root = nodes[(gltf.scenes as Array<{ nodes: number[] }>)[0]?.nodes[0] ?? -1];
  const m = root?.matrix ?? [];
  return [0, 1, 2].map(
    (row) =>
      (m[row] ?? 0) * point[0] + (m[4 + row] ?? 0) * point[1] + (m[8 + row] ?? 0) * point[2] + (m[12 + row] ?? 0),
  );
}

describe("normalizing a GLB for the factory scene", () => {
  it("scales a model into its category's space and puts its origin under the middle of its footprint", () => {
    // In millimetres and far from its origin, as generated files often are.
    const source = makeBoxGlb({ size: [1800, 1100, 1000], center: [5000, -200, 300] });
    const { bytes, report } = normalizeGlb(source, { space: [0.9, 0.55, 0.5] });

    expect(report.yawDeg).toBe(0);
    expect(report.upAxis).toBe("Y");
    expect(report.scale).toBeCloseTo(0.0005, 8);
    close(report.size, [0.9, 0.55, 0.5]);
    close(report.bounds.min, [-0.45, 0, -0.25]);
    close(report.bounds.max, [0.45, 0.55, 0.25]);
    expect(report.bounds.anchor).toEqual([0, 0, 0]);
    expect(report).toMatchObject({ vertices: 24, triangles: 12 });

    // The lowest, centre point of the source stands on the origin; its top is 0.55 m up.
    close(placed(bytes, [5000, -750, 300]), [0, 0, 0]);
    close(placed(bytes, [5000, 350, 300]), [0, 0.55, 0]);
    close(placed(bytes, [5900, -750, 800]), [0.45, 0, 0.25]);
  });

  it("keeps proportions: a model that is too tall for its space is limited by its height", () => {
    const { report } = normalizeGlb(makeBoxGlb({ size: [1, 4, 1] }), { space: [1, 2, 1] });
    expect(report.scale).toBeCloseTo(0.5, 8);
    close(report.size, [0.5, 2, 0.5]);
  });

  it("turns a model a quarter when it then fills its space better, and not otherwise", () => {
    // A conveyor lying along Z in a space that is long along X.
    const lying = normalizeGlb(makeBoxGlb({ size: [0.8, 0.8, 2.4] }), { space: [2.4, 0.8, 0.8] });
    expect(lying.report.yawDeg).toBe(90);
    close(lying.report.size, [2.4, 0.8, 0.8]);
    // What pointed along +Z in the file points along +X in the scene.
    close(placed(lying.bytes, [0, 0, 1.2]), [1.2, 0.4, 0]);

    expect(normalizeGlb(makeBoxGlb({ size: [2.4, 0.8, 0.8] }), { space: [2.4, 0.8, 0.8] }).report.yawDeg).toBe(0);
    expect(normalizeGlb(makeBoxGlb({ size: [1, 1, 1] }), { space: [2.4, 0.8, 0.8] }).report.yawDeg).toBe(0);
    // A cabinet a little deeper than wide would fit 6 % better turned; its door stays in front.
    expect(normalizeGlb(makeBoxGlb({ size: [0.5, 1, 0.53] }), { space: [0.8, 1.6, 0.5] }).report.yawDeg).toBe(0);
    expect(normalizeGlb(makeBoxGlb({ size: [0.5, 1, 0.7] }), { space: [0.8, 1.6, 0.5] }).report.yawDeg).toBe(90);
  });

  it("turns the file as the author says, also by an angle that is no quarter turn", () => {
    const back = normalizeGlb(makeBoxGlb({ size: [1, 1, 2] }), { space: [1, 1, 2], yawDeg: 180 });
    expect(back.report.yawDeg).toBe(180);
    close(placed(back.bytes, [0, 0, 1]), [0, 0.5, -1]);

    const diagonal = normalizeGlb(makeBoxGlb({ size: [1, 1, 1] }), { space: [10, 10, 10], yawDeg: 45 });
    // A unit square turned by 45° is √2 wide: the box is measured from its corners, not guessed.
    expect(diagonal.report.sourceSize[0]).toBeCloseTo(Math.SQRT2, 5);
    expect(diagonal.report.sourceSize[2]).toBeCloseTo(Math.SQRT2, 5);
  });

  it("stands a Z-up file upright", () => {
    // 2 high along Z in the file, 0.5 deep along Y.
    const { bytes, report } = normalizeGlb(makeBoxGlb({ size: [1, 0.5, 2] }), {
      space: [1, 2, 0.5],
      upAxis: "Z",
      yawDeg: 0,
    });
    close(report.size, [1, 2, 0.5]);
    // The file's top (+Z) is up; what faced the viewer in a Z-up file (−Y) faces +Z.
    close(placed(bytes, [0, 0, 1]), [0, 2, 0]);
    close(placed(bytes, [0, -0.25, 0]), [0, 1, 0.25]);
  });

  it("measures through the transforms of the file's own nodes", () => {
    const source = makeBoxGlb({
      size: [1, 1, 1],
      patch: (gltf) => {
        gltf.nodes = [
          { children: [1], scale: [2, 2, 2], translation: [10, 0, 0] },
          { mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [3, 1, 1] },
        ];
      },
    });
    // The box is 3 long along X, turned to stand along Y, then doubled: 2 × 6 × 2.
    const { report } = normalizeGlb(source, { space: [1, 3, 1], yawDeg: 0 });
    close(report.sourceSize, [2, 6, 2]);
    close(report.size, [1, 3, 1]);
  });

  it("leaves geometry and materials as they are and returns a file the catalog accepts", () => {
    const source = makeBoxGlb({ size: [3, 2, 1], center: [1, 1, 1] });
    const { bytes } = normalizeGlb(source, { space: [0.6, 0.7, 0.35] });
    const before = readGlb(source);
    const after = readGlb(bytes);

    expect(after.binary).toEqual(before.binary);
    expect(after.gltf.meshes).toEqual(before.gltf.meshes);
    expect(after.gltf.materials).toEqual(before.gltf.materials);
    expect(after.gltf.accessors).toEqual(before.gltf.accessors);
    expect((after.gltf.nodes as unknown[]).length).toBe((before.gltf.nodes as unknown[]).length + 1);
    expect(inspectGlb(bytes).counts).toMatchObject({ meshes: 1, nodes: 2, materials: 1 });

    // Normalizing what is normalized changes nothing about where the model stands.
    const again = normalizeGlb(bytes, { space: [0.6, 0.7, 0.35] });
    expect(again.report.scale).toBeCloseTo(1, 6);
    close(again.report.bounds.min, [-0.3, 0, -0.1]);
  });

  it("refuses a file it cannot place", () => {
    const options = { space: [1, 1, 1] } as const;
    expect(rule(() => normalizeGlb(new TextEncoder().encode("not a model at all, just text"), options))).toBe(
      "glb-format",
    );
    expect(rule(() => normalizeGlb(makeBoxGlb({ size: [0, 0, 0] }), options))).toBe("glb-empty");
    expect(rule(() => normalizeGlb(makeBoxGlb({ patch: (gltf) => (gltf.scenes = [{ nodes: [] }]) }), options))).toBe(
      "glb-empty",
    );
    expect(
      rule(() => normalizeGlb(makeBoxGlb({ patch: (gltf) => (gltf.nodes = [{ mesh: 0, children: [0] }]) }), options)),
    ).toBe("glb-nodes");
    const heavy = makeBoxGlb({
      patch: (gltf) => {
        (gltf.accessors as Array<{ count: number }>)[2]!.count = (MAX_ASSET_TRIANGLES + 1) * 3;
      },
    });
    expect(rule(() => normalizeGlb(heavy, options))).toBe("glb-triangles");
  });
});

const catalog = loadCatalog();
const categoryName = new Map(GENERIC_CATEGORIES.map((category) => [category.code, category.name]));
const catalogModels: PromptModel[] = (catalog.models ?? []).map((model) => ({
  modelName: model.modelName,
  sku: model.sku ?? null,
  manufacturer: model.manufacturer,
  family: model.family,
  categoryCode: model.category,
  categoryName: categoryName.get(model.category) ?? model.category,
  architectureType: model.architectureType ?? null,
  verificationStatus: model.verification.status,
}));
const named = (modelName: string) => {
  const model = catalogModels.find((candidate) => candidate.modelName === modelName);
  if (!model) throw new Error(`No catalog model ${modelName}`);
  return model;
};

describe("the prompt an asset is generated from", () => {
  it("describes every catalog model as a generic, unbranded shape within the provider's limit", () => {
    expect(catalogModels).toHaveLength(32);
    for (const model of catalogModels) {
      const { prompt, texturePrompt } = buildAssetPrompt(model, { vendorModels: catalogModels });
      expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
      expect(prompt).toMatch(/^An? [a-z]/);
      expect(prompt).toContain("generic and unbranded");
      expect(prompt).toContain("No logo, no text, no label, no nameplate");
      expect(texturePrompt).toContain("no logo");
    }
  });

  it("never names a manufacturer, family, model or order number of a vendor record", () => {
    const vendors = catalogModels.filter((model) => model.verificationStatus !== "GENERIC");
    expect(vendors.map((model) => model.manufacturer).sort()).toEqual([
      "Rockwell Automation",
      "Schneider Electric",
      "Siemens",
      "Siemens",
    ]);
    for (const model of vendors) {
      const { prompt, texturePrompt, subject } = buildAssetPrompt(model, { vendorModels: catalogModels });
      const text = `${prompt} ${texturePrompt} ${subject}`.toLowerCase();
      for (const word of [
        "siemens",
        "simatic",
        "s7",
        "1214",
        "1511",
        "rockwell",
        "compactlogix",
        "5069",
        "schneider",
        "modicon",
        "m241",
        "tm241",
      ]) {
        expect(text).not.toContain(word);
      }
      if (model.sku) expect(text).not.toContain(model.sku.toLowerCase());
    }
    // A PLC of a vendor is a compact controller or a cabinet; only compact or modular tells two apart.
    expect(buildAssetPrompt(named("CPU 1214C DC/DC/DC")).prompt).toContain("compact programmable logic controller");
    expect(buildAssetPrompt(named("TM241CE24T")).prompt).toBe(buildAssetPrompt(named("CPU 1214C DC/DC/DC")).prompt);
    expect(buildAssetPrompt(named("5069-L306ER")).prompt).toContain("two closed front doors");
  });

  it("gives models of one shape one key, so they can share a generated file", () => {
    const key = (modelName: string) => buildAssetPrompt(named(modelName)).shapeKey;
    expect(key("CPU 1214C DC/DC/DC")).toBe(key("TM241CE24T"));
    expect(key("CPU 1511-1 PN")).toBe(key("5069-L306ER"));
    expect(key("CPU 1214C DC/DC/DC")).not.toBe(key("CPU 1511-1 PN"));
    expect(key("Generic VFD, hardwired control")).toBe(key("Generic VFD, Modbus TCP"));
    expect(key("Generic pressure transmitter, 4–20 mA")).toBe("sensor:pressure transmitter");
    expect(key("Generic pressure transmitter, 4–20 mA")).toBe(key("Generic pressure transmitter, 0–10 V"));
    expect(key("Generic pressure transmitter, 4–20 mA")).not.toBe(key("Generic level transmitter, 4–20 mA"));
    expect(new Set(catalogModels.map((model) => buildAssetPrompt(model).shapeKey)).size).toBe(28);
  });

  it("describes the kind of device, not only its category", () => {
    const prompt = (modelName: string) => buildAssetPrompt(named(modelName)).prompt;
    expect(prompt("Generic three-phase motor")).toContain("three-phase electric motor");
    expect(prompt("Generic control valve, 4–20 mA")).toContain("diaphragm actuator");
    expect(prompt("Generic on/off valve, 24 V DC")).toContain("ball valve");
    expect(prompt("Generic limit switch, 24 V DC")).toContain("lever arm");
    expect(prompt("Generic belt conveyor")).toContain("belt conveyor");
    // A transmitter is not a gauge: the first generated one came out with a dial.
    expect(prompt("Generic pressure transmitter, 4–20 mA")).toContain("no dial and no pointer");
    expect(prompt("Generic flow transmitter, 4–20 mA")).toContain("electromagnetic flow meter");
    expect(prompt("Generic VFD, hardwired control")).toContain("heat sink");
    // Electrical data says nothing about a shape and stays out of the prompt.
    expect(prompt("Generic pressure transmitter, 4–20 mA")).not.toMatch(/mA|4–20/);
  });

  it("describes a category it has no form for as a plain housing", () => {
    const model: PromptModel = {
      ...named("Generic fan"),
      categoryCode: "FUTURE_THING",
      modelName: "Generic particle counter",
    };
    expect(buildAssetPrompt(model).prompt).toContain("particle counter, simple rectangular equipment housing");
  });

  it("takes words from the author, and refuses a manufacturer's name among them", () => {
    const fan = named("Generic fan");
    expect(buildAssetPrompt(fan, { hint: "with a round inlet cone." }).prompt).toContain(
      "on a floor stand. with a round inlet cone. Single complete object",
    );
    const refused = (hint: string, model = fan) =>
      rule(() => buildAssetPrompt(model, { hint, vendorModels: catalogModels }));
    expect(refused("like a Siemens motor")).toBe("asset-prompt-generic");
    expect(refused("in the style of the S7-1200")).toBe("asset-prompt-generic");
    expect(refused("shaped like a 5069-L306ER")).toBe("asset-prompt-generic");
    expect(refused("Allen-Bradley look", named("TM241CE24T"))).toBe("asset-prompt-generic");
    expect(refused("x".repeat(400))).toBe("asset-prompt-length");
    expect(rule(() => assertGenericPrompt("a grey cabinet with a compact door", catalogModels))).toBeUndefined();
  });
});

const generation: GenerationRequest = {
  prompt: "A fan.",
  texturePrompt: "grey paint",
  aiModel: "meshy-6",
  targetPolycount: 30_000,
  textured: true,
};
const KEY = "msy_test_key_0123456789abcdef";

/** A stand-in for `fetch` that answers from a list and remembers what it was asked. */
function fakeFetch(answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected request");
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the Meshy provider", () => {
  it("asks for a mesh and for its texture the way the provider documents it", async () => {
    const { fetcher, calls } = fakeFetch([jsonResponse({ result: "mesh-1" }), jsonResponse({ result: "texture-1" })]);
    const provider = createMeshyProvider({ apiKey: KEY, fetch: fetcher });

    expect(await provider.startMesh(generation)).toBe("mesh-1");
    expect(await provider.startTexture("mesh-1", generation)).toBe("texture-1");

    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ["POST", "https://api.meshy.ai/openapi/v2/text-to-3d"],
      ["POST", "https://api.meshy.ai/openapi/v2/text-to-3d"],
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      mode: "preview",
      prompt: "A fan.",
      ai_model: "meshy-6",
      topology: "triangle",
      should_remesh: true,
      target_polycount: 30_000,
      target_formats: ["glb"],
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      mode: "refine",
      preview_task_id: "mesh-1",
      ai_model: "meshy-6",
      enable_pbr: false,
      texture_prompt: "grey paint",
      target_formats: ["glb"],
    });
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("reads a task's state, progress, failure reason and GLB address", async () => {
    const { fetcher, calls } = fakeFetch([
      jsonResponse({ status: "IN_PROGRESS", progress: 41.6, model_urls: {}, task_error: { message: "" } }),
      jsonResponse({
        status: "SUCCEEDED",
        progress: 100,
        model_urls: { glb: "https://assets.meshy.ai/x/model.glb?sig=1" },
      }),
      jsonResponse({ status: "FAILED", progress: 0, task_error: { message: "The prompt was refused." } }),
      jsonResponse({ status: "SOMETHING_NEW" }),
    ]);
    const provider = createMeshyProvider({ apiKey: KEY, fetch: fetcher });

    expect(await provider.getJob("a/b")).toEqual({
      id: "a/b",
      status: "IN_PROGRESS",
      progress: 42,
      message: null,
      glbUrl: null,
    });
    expect(calls[0]).toMatchObject({
      url: "https://api.meshy.ai/openapi/v2/text-to-3d/a%2Fb",
      init: { method: "GET" },
    });
    expect(await provider.getJob("t")).toMatchObject({
      status: "SUCCEEDED",
      glbUrl: "https://assets.meshy.ai/x/model.glb?sig=1",
    });
    expect(await provider.getJob("t")).toMatchObject({ status: "FAILED", message: "The prompt was refused." });
    await expect(provider.getJob("t")).rejects.toMatchObject({ details: { rule: "meshy-response" } });
  });

  it("says why a request was refused without ever repeating the key", async () => {
    const { fetcher } = fakeFetch([
      jsonResponse({ message: `Invalid API key ${KEY}` }, 401),
      jsonResponse({ message: "Insufficient credits" }, 402),
      jsonResponse({}, 429),
      jsonResponse({ message: "prompt too long" }, 400),
      new Error(`connect ECONNREFUSED with Authorization: Bearer ${KEY}`),
      jsonResponse({}),
    ]);
    const provider = createMeshyProvider({ apiKey: KEY, fetch: fetcher });
    const errors: DomainError[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await provider.startMesh(generation).catch((error: DomainError) => errors.push(error));
    }
    expect(errors.map((error) => error.message)).toEqual([
      "Meshy did not accept the API key.",
      "The Meshy account has too few credits.",
      "Meshy is limiting requests; try again later.",
      "Meshy refused the request (400): prompt too long",
      "Meshy could not be reached.",
      "Meshy did not return a task id.",
    ]);
    expect(errors.map((error) => error.details.rule)).toEqual([
      "meshy-refused",
      "meshy-refused",
      "meshy-refused",
      "meshy-refused",
      "meshy-unreachable",
      "meshy-response",
    ]);
    for (const error of errors) {
      expect(error.code).toBe("RUNTIME_FAILURE");
      expect(`${error.message} ${JSON.stringify(error.details)} ${String(error.cause ?? "")}`).not.toContain(KEY);
    }
  });

  it("downloads only from the provider's own hosts, over HTTPS, and without the key", async () => {
    const glb = makeBoxGlb();
    const { fetcher, calls } = fakeFetch([
      new Response(glb.slice().buffer as ArrayBuffer),
      new Response("gone", { status: 403 }),
    ]);
    const provider = createMeshyProvider({ apiKey: KEY, fetch: fetcher });

    expect(await provider.download("https://assets.meshy.ai/tasks/1/model.glb?Expires=1")).toEqual(glb);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.init ?? {})).not.toContain(KEY);
    expect(calls[0]?.init?.headers).toBeUndefined();

    for (const url of [
      "http://assets.meshy.ai/model.glb",
      "https://assets.meshy.ai.example.com/model.glb",
      "https://example.com/model.glb",
      "https://notmeshy.ai/model.glb",
      "file:///etc/passwd",
      "not an address",
    ]) {
      await expect(provider.download(url)).rejects.toMatchObject({ details: { rule: "meshy-download" } });
    }
    expect(calls).toHaveLength(1);
    await expect(provider.download("https://assets.meshy.ai/model.glb")).rejects.toMatchObject({
      message: "The generated model could not be downloaded (403).",
    });
  });

  it("estimates what a generation costs", () => {
    expect(estimateCredits({ textured: true })).toBe(30);
    expect(estimateCredits({ textured: false })).toBe(20);
  });
});

describe("where the provider and its key may be used", () => {
  const sources = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return name === "generated" || name === "node_modules" ? [] : sources(path);
      return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  const imports = (path: string) =>
    [...readFileSync(path, "utf8").matchAll(/from\s+"([^"]+)"|import\("([^"]+)"\)/g)].map(
      (match) => match[1] ?? match[2] ?? "",
    );

  it("is the authoring script only: no page, route, action or component can generate", () => {
    const provider = /(^|\/)(assets\/meshy|asset-authoring-service)$/;
    const users = [...sources("app"), ...sources("components"), ...sources("lib")].filter((path) =>
      imports(path).some((specifier) => provider.test(specifier)),
    );
    // The authoring service uses the provider; nothing the application serves uses either.
    expect(users).toEqual(["lib/services/asset-authoring-service.ts"]);
    expect(imports("scripts/catalog-assets.ts").some((specifier) => provider.test(specifier))).toBe(true);
  });

  it("keeps the key out of the source, the example environment and anything a browser gets", () => {
    const mentions = [...sources("app"), ...sources("components"), ...sources("lib"), ...sources("scripts")].filter(
      (path) => readFileSync(path, "utf8").includes("MESHY_API_KEY"),
    );
    expect(mentions.sort()).toEqual(["lib/env.ts", "scripts/catalog-assets.ts"]);
    expect(readFileSync(".env.example", "utf8")).toMatch(/^# MESHY_API_KEY=$/m);
    for (const path of [...sources("app"), ...sources("components"), ...sources("lib"), ...sources("scripts")]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/NEXT_PUBLIC_[A-Z_]*MESHY|msy_[A-Za-z0-9]{20,}/);
    }
  });

  it("is optional: the application starts without a key and refuses one that is malformed", () => {
    const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
    expect(parseServerEnv(base).MESHY_API_KEY).toBeUndefined();
    expect(parseServerEnv({ ...base, MESHY_API_KEY: KEY }).MESHY_API_KEY).toBe(KEY);
    expect(() => parseServerEnv({ ...base, MESHY_API_KEY: "two words" })).toThrow("MESHY_API_KEY");
    // The message names the variable and never its value.
    expect(() => parseServerEnv({ ...base, MESHY_API_KEY: "short" })).not.toThrow("short");
  });

  it("fits every catalog category into a space, so any model can be normalized", () => {
    for (const category of GENERIC_CATEGORIES) {
      expect(placeholderFor(category.code).size.every((length) => length > 0)).toBe(true);
    }
  });
});
