import "server-only";
import type { RuntimeImage } from "./policy";

/**
 * The image allow-list. Z-Factory runs only the images listed here, selected by key.
 *
 * It is intentionally empty until the owning tasks add their reusable runtime images
 * with a pinned tag and digest: OpenPLC (TASK-202), the device simulator (TASK-204)
 * and the optional gateway simulator (Phase 05). Do not add an image per PLC or device.
 */
export const RUNTIME_IMAGES: readonly RuntimeImage[] = [];
