"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SideSection } from "@/components/shell/side-bar";
import type { PaletteGroupView } from "@/lib/domain/topology-view";

/** Drag payload type of a palette item: the id of a catalog model. */
export const PALETTE_MIME = "application/x-zfactory-model";

type PlaceResult = { ok: true; value: { id: string; name: string } } | { ok: false; message: string };

type DevicePaletteProps = {
  groups: readonly PaletteGroupView[];
  /** Server action that creates a device from a catalog model at a canvas position. */
  onPlace: (input: { deviceModelId: string; x: number; y: number }) => Promise<PlaceResult>;
  /** How many devices exist; new ones added by button are offset so they do not stack. */
  deviceCount: number;
};

/**
 * 2d — palette of catalog models. An item is dragged onto the canvas, or added with its
 * button for keyboard use; either way a named device instance is created.
 */
export function DevicePalette({ groups, onPlace, deviceCount }: DevicePaletteProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string>();

  const add = (deviceModelId: string) =>
    startTransition(async () => {
      const result = await onPlace({ deviceModelId, x: 80 + (deviceCount % 5) * 40, y: 80 + (deviceCount % 5) * 40 });
      setMessage(result.ok ? `Added ${result.value.name}` : result.message);
      if (result.ok) router.refresh();
    });

  return (
    <>
      {message ? (
        <p className="zf-k px-2.5 py-1.5" role="status">
          {message}
        </p>
      ) : null}
      {groups.map((group) => (
        <SideSection key={group.categoryCode} title={group.categoryName.split(" / ")[0] ?? group.categoryName}>
          <ul>
            {group.items.map((item) => (
              <li
                key={item.modelId}
                className="zf-palette-item"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(PALETTE_MIME, item.modelId);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                title={`${item.manufacturer} ${item.modelName}`}
              >
                <span>{item.modelName}</span>
                <button
                  type="button"
                  className="zf-btn"
                  data-variant="ghost"
                  data-size="sm"
                  disabled={pending}
                  onClick={() => add(item.modelId)}
                  aria-label={`Add ${item.modelName}`}
                >
                  +
                </button>
              </li>
            ))}
          </ul>
        </SideSection>
      ))}
    </>
  );
}
