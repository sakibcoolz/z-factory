/**
 * The devices of a factory as a hierarchy, the way they are connected: a PLC with the
 * devices connected to it, and below a device what is reached through it (a drive's
 * motor, a motor's pump). Pure; importable anywhere.
 *
 * The hierarchy is a way of reading the connections. It stores nothing and decides nothing.
 */

/** Two connected devices. The direction of a connection does not matter for the hierarchy. */
export type DeviceLink = {
  sourceId: string;
  targetId: string;
  /**
   * A connection that says what a device observes, not what it is part of: a sensor
   * measuring a pump. It places a device only when nothing else does.
   */
  weak?: boolean;
};

export type DeviceTreeNode<Device> = { device: Device; children: DeviceTreeNode<Device>[] };

type TreeDevice = { id: string; name: string };

const byName = (a: TreeDevice, b: TreeDevice) => a.name.localeCompare(b.name, undefined, { numeric: true });

/**
 * Every device once. PLCs are the roots; a device hangs below the PLC it is nearest to,
 * under the device it is reached through. Devices with no path to a PLC follow as roots
 * of their own: a drive with its motor, or a device that is connected to nothing.
 */
export function buildDeviceTree<Device extends TreeDevice>(
  devices: readonly Device[],
  links: readonly DeviceLink[],
  isPlc: (device: Device) => boolean,
): DeviceTreeNode<Device>[] {
  const ordered = [...devices].sort(byName);
  const byId = new Map(ordered.map((device) => [device.id, device]));
  const adjacency = () => new Map<string, Set<string>>(ordered.map((device) => [device.id, new Set()]));
  const strong = adjacency();
  const all = adjacency();
  const hasIncoming = new Set<string>();
  for (const { sourceId, targetId, weak } of links) {
    if (sourceId === targetId || !byId.has(sourceId) || !byId.has(targetId)) continue;
    for (const neighbours of weak ? [all] : [strong, all]) {
      neighbours.get(sourceId)?.add(targetId);
      neighbours.get(targetId)?.add(sourceId);
    }
    hasIncoming.add(targetId);
  }

  const nodes = new Map<string, DeviceTreeNode<Device>>();
  const roots: DeviceTreeNode<Device>[] = [];

  /** Breadth first, so a device hangs on the shortest way to a root; all starts advance together. */
  const expand = (starts: readonly DeviceTreeNode<Device>[], neighbours: Map<string, Set<string>>) => {
    const reached = [...starts];
    for (let index = 0; index < reached.length; index += 1) {
      const parent = reached[index] as DeviceTreeNode<Device>;
      const linked = [...(neighbours.get(parent.device.id) ?? [])].flatMap((id) => byId.get(id) ?? []).sort(byName);
      for (const device of linked) {
        if (nodes.has(device.id)) continue;
        const node = { device, children: [] };
        nodes.set(device.id, node);
        parent.children.push(node);
        reached.push(node);
      }
    }
    return reached;
  };

  /** New roots with everything below them: first by what a device is part of, then by what merely observes it. */
  const grow = (starts: readonly Device[]) => {
    const added = starts
      .filter((device) => !nodes.has(device.id))
      .map((device) => {
        const node: DeviceTreeNode<Device> = { device, children: [] };
        nodes.set(device.id, node);
        roots.push(node);
        return node;
      });
    if (added.length > 0) expand(expand(added, strong), all);
  };

  grow(ordered.filter(isPlc));
  // Without a PLC, a chain starts at the device nothing leads to: the drive, not its motor.
  for (const device of ordered) if (!hasIncoming.has(device.id)) grow([device]);
  for (const device of ordered) grow([device]);
  return roots;
}

/** The devices below a node, at any depth. */
export function countDescendants<Device>(node: DeviceTreeNode<Device>): number {
  return node.children.reduce((count, child) => count + 1 + countDescendants(child), 0);
}

export type FlatTreeRow<Device> = { device: Device; depth: number; rootId: string; descendants: number };

/** The tree as rows from top to bottom, each with its depth and the root it belongs to. */
export function flattenDeviceTree<Device extends { id: string }>(
  roots: readonly DeviceTreeNode<Device>[],
): FlatTreeRow<Device>[] {
  const rows: FlatTreeRow<Device>[] = [];
  const walk = (node: DeviceTreeNode<Device>, depth: number, rootId: string) => {
    rows.push({ device: node.device, depth, rootId, descendants: countDescendants(node) });
    for (const child of node.children) walk(child, depth + 1, rootId);
  };
  for (const root of roots) walk(root, 0, root.device.id);
  return rows;
}
