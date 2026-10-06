import type { ReactNode } from "react";
import { formatFact, signalTypeLabel } from "@/lib/catalog/format";
import { DIAGRAM_NODE, layoutDiagram } from "@/lib/export/diagram";
import { type PlcExportDocument, REPORT_SECTIONS } from "@/lib/export/plc-export";
import { RELATIONSHIP_LABELS } from "@/lib/topology/flow";

type PlcReportProps = { document: PlcExportDocument };

const dash = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === "" ? "—" : String(value);
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const relationship = (value: string) =>
  RELATIONSHIP_LABELS[value as keyof typeof RELATIONSHIP_LABELS] ?? value.toLowerCase();

function Section({ index, children }: { index: number; children: ReactNode }) {
  return (
    <section className="zf-report-section" aria-labelledby={`report-section-${index}`}>
      <h3 id={`report-section-${index}`} className="zf-sheet-k">{`${index} · ${REPORT_SECTIONS[index - 1]}`}</h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="zf-report-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="zf-sheet-k">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Table({
  columns,
  rows,
  empty,
}: {
  columns: readonly string[];
  rows: ReadonlyArray<readonly ReactNode[]>;
  empty: string;
}) {
  if (rows.length === 0) return <p className="zf-report-empty">{empty}</p>;
  return (
    <table>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Diagram({ topology }: { topology: PlcExportDocument["topology"] }) {
  const layout = layoutDiagram(topology);
  if (layout.nodes.length === 0) return <p className="zf-report-empty">No devices.</p>;
  return (
    <svg
      className="zf-report-diagram"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={`Topology of ${layout.nodes.length} devices and ${layout.edges.length} connections`}
    >
      {layout.edges.map((edge, index) => (
        <g key={index}>
          <line x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} strokeDasharray={edge.dashed ? "4 3" : undefined} />
          <text x={(edge.x1 + edge.x2) / 2} y={(edge.y1 + edge.y2) / 2 - 3} textAnchor="middle">
            {edge.label}
          </text>
        </g>
      ))}
      {layout.nodes.map((node) => (
        <g key={node.id}>
          <rect x={node.x} y={node.y} width={DIAGRAM_NODE.width} height={DIAGRAM_NODE.height} />
          <text x={node.x + 6} y={node.y + 15} className="zf-report-diagram-name">
            {node.name}
          </text>
          <text x={node.x + 6} y={node.y + 29}>
            {node.kind}
          </text>
        </g>
      ))}
    </svg>
  );
}

/**
 * 2p — the engineering report of one PLC: the 15 sections of docs/plc-export.md, drawn
 * from the export document alone. Laid out for A4 / Letter and printed from the browser.
 */
export function PlcReport({ document }: PlcReportProps) {
  const { plc, model, factory, revision, hardware, network } = document;
  const supply = document.electrical
    ? [
        document.electrical.nominalVoltage !== null ? `${document.electrical.nominalVoltage} V` : null,
        document.electrical.supplyType,
        document.electrical.voltageMin !== null && document.electrical.voltageMax !== null
          ? `(${document.electrical.voltageMin}–${document.electrical.voltageMax} V)`
          : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "not recorded";
  const occupied = document.ioPoints.filter((point) => point.status !== "FREE");

  return (
    <article className="zf-sheet" data-size="report" aria-label="Engineering report">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="zf-sheet-k">Z-Factory · engineering export</div>
          <h2>{plc.role ? `${plc.name} — ${plc.role}` : plc.name}</h2>
        </div>
        <div className="zf-sheet-k text-right">
          {`rev ${revision.configuration}`}
          <br />
          {utc(document.generatedAt)}
        </div>
      </header>
      <div className="zf-sheet-rule" />

      <Section index={1}>
        <Facts
          rows={[
            ["Factory", `${factory.name} (${factory.slug})`],
            ["PLC instance", plc.name],
            ["Factory subnet", factory.subnetCidr],
          ]}
        />
      </Section>

      <Section index={2}>
        <Facts
          rows={[
            ["Manufacturer", model.manufacturer],
            ["Family", model.family],
            ["Model", model.modelName],
            ["Order no.", dash(model.sku)],
            ["Architecture", plc.architecture.toLowerCase()],
            ["Catalog record", model.verificationStatus.toLowerCase()],
          ]}
        />
        <p className="zf-report-note">
          {model.source
            ? `Source: ${dash(model.source.title)}, ${dash(model.source.revision)}; checked ${dash(model.source.verifiedAt)}. ${dash(model.source.url)}`
            : "Generic simulated profile; no vendor source."}
        </p>
      </Section>

      <Section index={3}>
        <Facts
          rows={[
            ["Process role", dash(plc.role)],
            ["Runtime", plc.runtime],
            ["Runtime version", dash(plc.runtimeVersion)],
          ]}
        />
        <p className="zf-report-note">{plc.runtimeNote}</p>
      </Section>

      <Section index={4}>
        <Facts
          rows={[
            ["Supply", supply],
            ...document.ports.map(
              (port) =>
                [
                  port.name,
                  `${port.portCount} × ${port.physicalType}${port.protocols.length > 0 ? ` · ${port.protocols.join(", ").replace("MODBUS_TCP", "Modbus TCP")}` : ""}`,
                ] as const,
            ),
            ...Object.entries(model.facts).map(([key, value]) => formatFact(key, value)),
          ]}
        />
      </Section>

      <Section index={5}>
        {hardware.rack ? (
          <>
            <p className="zf-report-note">{`${hardware.rack.name}: ${hardware.rack.modules.length} of ${hardware.rack.slotCount} slots used.`}</p>
            <Table
              columns={["Slot", "Module", "Order no.", "Type", "Channels", "Used"]}
              rows={hardware.rack.modules.map((module) => [
                module.slot,
                module.modelName,
                dash(module.sku),
                module.moduleType.toLowerCase().replace("_", " "),
                module.channels,
                module.occupied,
              ])}
              empty="No module installed."
            />
          </>
        ) : (
          <p className="zf-report-note">Compact PLC: built-in I/O, no rack.</p>
        )}
        <Table
          columns={["Class", "Channels", "Used", "Free"]}
          rows={hardware.channels.map((entry) => [
            entry.ioType,
            entry.count,
            entry.occupied,
            entry.count - entry.occupied,
          ])}
          empty="No I/O channels."
        />
      </Section>

      <Section index={6}>
        <Table
          columns={["Channel", "Signal", "Vendor addr.", "Program addr.", "Device · terminal", "Tag"]}
          rows={occupied.map((point) => [
            `${point.slot !== null ? `S${point.slot} ` : ""}${point.ioType} ${point.channel}`,
            point.signalTypes.map(signalTypeLabel).join(" / "),
            dash(point.vendorAddress),
            point.programAddress,
            `${dash(point.device)}${point.deviceTerminal ? ` · ${point.deviceTerminal}` : ""}`,
            dash(point.tag),
          ])}
          empty="No channel is in use."
        />
        <p className="zf-report-note">{`${occupied.length} of ${document.ioPoints.length} channels in use. Free channels are listed in the I/O schedule (CSV).`}</p>
      </Section>

      <Section index={7}>
        <Table
          columns={["Tag", "Role", "Type", "Program addr.", "Unit", "Device · signal"]}
          rows={document.tags.map((tag) => [
            tag.name,
            tag.role.toLowerCase().replace("_", " "),
            tag.dataType,
            tag.programAddress,
            dash(tag.unit),
            tag.sourceDevice ? `${tag.sourceDevice}${tag.sourceSignal ? ` · ${tag.sourceSignal}` : ""}` : "—",
          ])}
          empty="No tags."
        />
        {document.moduleSignals.length > 0 ? (
          <Table
            columns={["Process module", "Signal", "Direction", "Tag", "Program addr."]}
            rows={document.moduleSignals.map((row) => [
              `${row.module} (${row.moduleType})`,
              row.signal,
              row.direction.toLowerCase(),
              row.tag,
              row.programAddress,
            ])}
            empty="No process-module signals."
          />
        ) : null}
      </Section>

      <Section index={8}>
        <Table
          columns={["Tag", "Area", "Address", "Display", "Words", "Access", "Scale", "Offset"]}
          rows={document.tags.map((tag) => [
            tag.name,
            tag.modbusArea.toLowerCase().replace("_", " "),
            tag.modbusAddress,
            tag.modbusDisplayAddress,
            tag.wordCount,
            tag.accessMode === "READ_WRITE" ? "read/write" : "read only",
            tag.scale,
            tag.offset,
          ])}
          empty="No registers."
        />
        <p className="zf-report-note">
          {`Addresses are ${network.modbusConventions.addressBase}; ${network.modbusConventions.byteOrder.toLowerCase().replace("_", " ")}, ${network.modbusConventions.wordOrder.toLowerCase().replaceAll("_", " ")}. Engineering value = raw × scale + offset.`}
        </p>
      </Section>

      <Section index={9}>
        <Table
          columns={[
            "PLC point",
            "Tag",
            "Device instance",
            "Model",
            "Relationship",
            "Signal / protocol",
            "Address",
            "Unit",
          ]}
          rows={document.connectedDevices.map((row) => [
            row.plcPoint,
            dash(row.tag),
            row.device,
            row.model,
            relationship(row.relationship),
            row.signalOrProtocol,
            dash(row.address),
            dash(row.unit),
          ])}
          empty="No device is connected."
        />
      </Section>

      <Section index={10}>
        <Table
          columns={["From", "Relationship", "To", "Detail"]}
          rows={document.relationships.map((row) => [
            row.source,
            relationship(row.relationship),
            row.target,
            dash(row.detail),
          ])}
          empty="No relationships."
        />
      </Section>

      <Section index={11}>
        <Facts
          rows={[
            ["Name in factory network", dash(network.serviceName)],
            [
              "Modbus TCP endpoint",
              network.modbusEndpoint
                ? `${network.modbusEndpoint.bindAddress}:${network.modbusEndpoint.hostPort} → port ${network.modbusEndpoint.containerPort}`
                : "not configured (assigned when the PLC first starts)",
            ],
            [
              "Protocol devices",
              network.protocolLinks.length > 0
                ? network.protocolLinks.map((link) => `${link.device} (${link.protocol})`).join(", ")
                : "none",
            ],
            ["Gateways", "none configured"],
          ]}
        />
        {network.plcLinks.length > 0 ? (
          <Table
            columns={["Relationship", "Peer PLC", "Role", "Server", "Unit", "Poll", "State", "Version"]}
            rows={network.plcLinks.map((link) => [
              link.relationship.toLowerCase().replace("_", " "),
              link.peer,
              link.role,
              `${link.serverHost}:${link.serverPort} (${link.protocol})`,
              String(link.unitId),
              `${link.pollIntervalMs} ms`,
              link.enabled ? "enabled" : "disabled",
              `v${link.configVersion}`,
            ])}
            empty="No PLC-to-PLC link."
          />
        ) : null}
      </Section>

      <Section index={12}>
        <Facts
          rows={[
            [
              "Program",
              revision.program
                ? `v${revision.program.version} · ${revision.program.language} · ${revision.program.status.toLowerCase()} · sha256 ${revision.program.checksum.slice(0, 12)}`
                : "no program yet",
            ],
            ["I/O mapping", `v${revision.ioMapping}`],
            ["Modbus mapping", `v${revision.modbusMapping}`],
            [
              "Deployed snapshot",
              revision.deployedSnapshot
                ? `v${revision.deployedSnapshot.version} · ${utc(revision.deployedSnapshot.createdAt)}`
                : "never deployed",
            ],
            ["Runtime image", dash(plc.runtimeImage)],
          ]}
        />
      </Section>

      <Section index={13}>
        {document.runtime ? (
          <Facts
            rows={[
              ["State", document.runtime.state.toLowerCase()],
              ["Note", document.runtime.note],
            ]}
          />
        ) : (
          <p className="zf-report-note">Not requested for this export.</p>
        )}
      </Section>

      <Section index={14}>
        <Diagram topology={document.topology} />
      </Section>

      <Section index={15}>
        <Facts
          rows={[
            ["Exported", utc(document.generatedAt)],
            ["Configuration revision", revision.configuration],
            ["Schema", `${document.schema} v${document.schemaVersion}`],
          ]}
        />
        <p className="zf-report-note">
          The revision is a hash of the exported configuration: the same configuration always gives the same revision.
        </p>
      </Section>

      <footer className="zf-sheet-k mt-auto">{document.notice}</footer>
    </article>
  );
}
