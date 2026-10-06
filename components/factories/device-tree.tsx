"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { RuntimeStatePill } from "@/components/ui/state-pill";
import { controllerKind } from "@/lib/domain/device-capabilities";
import { type DeviceTreeNode, flattenDeviceTree } from "@/lib/domain/device-tree";
import type { FactoryDeviceView } from "@/lib/domain/plc-config-view";
import { routes } from "@/lib/navigation/routes";

type DeviceTreeProps = {
  factoryId: string;
  /** The devices as they are connected: PLCs first, each with what is connected to it. */
  nodes: DeviceTreeNode<FactoryDeviceView>[];
};

/** The deepest level that is drawn further in; anything below stays at this indent. */
const MAX_DEPTH = 4;

const devicesText = (count: number) => (count === 1 ? "1 device" : `${count} devices`);

/**
 * The devices of a factory as a hierarchy. A device with others connected below it is a
 * drop-down: closed it shows how many it holds, opened it lists them, indented by the
 * way they are connected. Every device appears once.
 */
export function DeviceTree({ factoryId, nodes }: DeviceTreeProps) {
  const rows = useMemo(() => flattenDeviceTree(nodes), [nodes]);
  const groups = useMemo(() => rows.filter((row) => row.depth === 0 && row.descendants > 0), [rows]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const toggle = (rootId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(rootId)) next.add(rootId);
      return next;
    });

  const faultedBelow = (rootId: string) =>
    rows.filter((row) => row.rootId === rootId && row.depth > 0 && row.device.runtimeStatus === "FAULTED").length;

  return (
    <div className="flex flex-col gap-2">
      {groups.length > 0 ? (
        <div className="flex justify-end gap-1.5">
          <button
            type="button"
            className="zf-btn"
            data-variant="ghost"
            data-size="sm"
            disabled={groups.every((group) => open.has(group.rootId))}
            onClick={() => setOpen(new Set(groups.map((group) => group.rootId)))}
          >
            Expand all
          </button>
          <button
            type="button"
            className="zf-btn"
            data-variant="ghost"
            data-size="sm"
            disabled={open.size === 0}
            onClick={() => setOpen(new Set())}
          >
            Collapse all
          </button>
        </div>
      ) : null}
      <table className="zf-tbl">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Model</th>
            <th>Role</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ device, depth, rootId, descendants }) => {
            const isRoot = depth === 0;
            if (!isRoot && !open.has(rootId)) return null;
            const expanded = open.has(rootId);
            const faulted = isRoot && !expanded ? faultedBelow(rootId) : 0;
            return (
              <tr key={device.id}>
                <td className="mono">
                  <span className="zf-tbl-node" data-depth={Math.min(depth, MAX_DEPTH)}>
                    {isRoot && descendants > 0 ? (
                      <button
                        type="button"
                        className="zf-tbl-toggle"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} the devices connected to ${device.name}`}
                        onClick={() => toggle(rootId)}
                      >
                        {expanded ? "−" : "+"}
                      </button>
                    ) : isRoot ? (
                      <span className="zf-tbl-toggle" data-empty="true" aria-hidden="true" />
                    ) : (
                      <span className="zf-tbl-branch" aria-hidden="true">
                        └
                      </span>
                    )}
                    <Link
                      href={
                        device.architectureType ? routes.plc(factoryId, device.id) : routes.device(factoryId, device.id)
                      }
                    >
                      {device.name}
                    </Link>
                    {isRoot && descendants > 0 ? (
                      <span className="zf-tbl-count">
                        {devicesText(descendants)}
                        {faulted > 0 ? ` · ${faulted} faulted` : ""}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td>{controllerKind(device) ?? device.categoryName}</td>
                <td>{`${device.manufacturer} ${device.modelName}`}</td>
                <td>{device.role ?? "—"}</td>
                <td>
                  <RuntimeStatePill state={device.runtimeStatus} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
