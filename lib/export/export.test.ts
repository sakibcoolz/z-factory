import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";
import { DIAGRAM_NODE, layoutDiagram } from "./diagram";
import { REPORT_SECTIONS } from "./plc-export";
import { findSensitive } from "./redaction";

describe("CSV cells", () => {
  it("quotes only what needs quoting and doubles embedded quotes", () => {
    expect(csvCell("VFD_01_RUN")).toBe("VFD_01_RUN");
    expect(csvCell("0–10 V / ±10 V")).toBe("0–10 V / ±10 V");
    expect(csvCell("Pump, inlet")).toBe('"Pump, inlet"');
    expect(csvCell('the "main" pump')).toBe('"the ""main"" pump"');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("writes numbers plainly and nothing for missing values", () => {
    expect([csvCell(0.01), csvCell(8192), csvCell(null), csvCell(undefined), csvCell(Number.NaN)]).toEqual([
      "0.01",
      "8192",
      "",
      "",
      "",
    ]);
  });

  it("keeps a spreadsheet from running user text as a formula", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-PT101")).toBe("'-PT101");
    expect(csvCell("@cmd")).toBe("'@cmd");
    // A located address is not a formula.
    expect(csvCell("%QX0.0")).toBe("%QX0.0");
  });

  it("joins rows with CRLF and ends with one", () => {
    expect(
      toCsv(
        ["A", "B"],
        [
          ["1", 2],
          ["x,y", null],
        ],
      ),
    ).toBe('A,B\r\n1,2\r\n"x,y",\r\n');
  });
});

describe("export redaction check", () => {
  it("finds nothing in ordinary engineering data", () => {
    expect(
      findSensitive({
        plc: { name: "PLC-01", role: "Token ring replacement study" },
        source: {
          url: "https://cache.industry.siemens.com/dl/files/145/39710145/att_5787/v1/s71200_easy_book_en-US_en-US.pdf",
        },
        tags: [{ name: "XV_101_Y1", programAddress: "%QX0.0", scale: 0.01 }],
        network: { modbusEndpoint: { bindAddress: "127.0.0.1", hostPort: 15001 } },
      }),
    ).toEqual([]);
  });

  it("flags fields that name secrets or Docker details, wherever they are nested", () => {
    const findings = findSensitive({
      plc: { dockerContainerId: "abc", runtime: { apiPassword: "x" } },
      list: [{ credentials: {} }, { api_key: 1 }, { RUNTIME_SECRET: "y" }],
    });
    expect(findings.map((finding) => finding.path)).toEqual([
      "$.plc.dockerContainerId",
      "$.plc.runtime.apiPassword",
      "$.list[0].credentials",
      "$.list[1].api_key",
      "$.list[2].RUNTIME_SECRET",
    ]);
  });

  it("flags values that are a Docker endpoint, a host path, a key or a token", () => {
    const reasons = (value: string) => findSensitive({ note: value }).map((finding) => finding.reason);
    expect(reasons("unix:///var/run/docker.sock")).toEqual(["the Docker socket"]);
    expect(reasons("tcp://docker-proxy:2375")).toEqual(["a Docker TCP endpoint"]);
    expect(reasons("/home/operator/.ssh/id_ed25519")).toEqual(["a host path"]);
    expect(reasons("-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["a private key"]);
    expect(reasons("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6")).toEqual(["a bearer token"]);
    // A located address or a ratio is not a path.
    expect(reasons("%MW10")).toEqual([]);
    expect(reasons("4–20 mA / 0–10 V")).toEqual([]);
  });
});

describe("topology diagram layout", () => {
  const nodes = [
    { id: "plc", name: "PLC-01", kind: "PLC · compact", x: 100, y: 100 },
    { id: "valve", name: "XV-101", kind: "Valve", x: 1300, y: 500 },
    { id: "vfd", name: "VFD-01", kind: "Variable-frequency drive", x: 700, y: -200 },
  ];
  const edges = [
    { sourceId: "plc", targetId: "valve", relationship: "CONTROLS", label: "controls · 1 wire" },
    { sourceId: "plc", targetId: "vfd", relationship: "COMMUNICATES_WITH", label: "communicates with · Modbus TCP" },
    { sourceId: "plc", targetId: "gone", relationship: "CONTROLS", label: "controls" },
  ];

  it("scales any canvas into the drawing area with every node fully inside", () => {
    const layout = layoutDiagram({ nodes, edges }, 720, 300);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + DIAGRAM_NODE.width).toBeLessThanOrEqual(720);
      expect(node.y + DIAGRAM_NODE.height).toBeLessThanOrEqual(300);
    }
    // Relative order is kept: the valve stays right of and below the PLC.
    const [plc, valve] = layout.nodes;
    expect(valve && plc && valve.x > plc.x && valve.y > plc.y).toBe(true);
  });

  it("draws an edge between node centres, dashed for network and feedback, and skips dangling ones", () => {
    const layout = layoutDiagram({ nodes, edges });
    expect(layout.edges.map((edge) => [edge.label, edge.dashed])).toEqual([
      ["controls · 1 wire", false],
      ["communicates with · Modbus TCP", true],
    ]);
  });

  it("handles a PLC alone and an empty topology", () => {
    expect(layoutDiagram({ nodes: [], edges: [] }).nodes).toEqual([]);
    const alone = layoutDiagram({ nodes: nodes.slice(0, 1), edges: [] });
    expect(alone.nodes).toMatchObject([{ x: 8, y: 8 }]);
  });
});

describe("report sections", () => {
  it("lists the 15 sections of the export specification in order", () => {
    expect(REPORT_SECTIONS).toHaveLength(15);
    expect(REPORT_SECTIONS[8]).toBe("Connected-device schedule");
    expect(REPORT_SECTIONS[14]).toBe("Export timestamp & configuration revision");
  });
});
