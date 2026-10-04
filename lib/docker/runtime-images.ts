import "server-only";
import type { RuntimeImage } from "./policy";

/**
 * The image allow-list. Z-Factory runs only the images listed here, selected by key,
 * each pinned to a tag and digest. Do not add an image per PLC or device: runtime
 * images are reusable and take their PLC-specific program and configuration at run time.
 *
 * Still to come: the device simulator (TASK-204) and the optional gateway simulator
 * (Phase 05).
 */

/** Key of the OpenPLC runtime image (ADR-0009). */
export const OPENPLC_IMAGE_KEY = "openplc";

export const RUNTIME_IMAGES: readonly RuntimeImage[] = [
  {
    key: OPENPLC_IMAGE_KEY,
    // Official OpenPLC Runtime v4 image (Autonomy-Logic/openplc-runtime, MIT).
    reference: "ghcr.io/autonomy-logic/openplc-runtime:v4.2.4",
    digest: "sha256:8412ffa8a5de98caba7a2b1cc03009f944e8153175361b61297f34f7a501fc4f",
    // 8443: REST API (HTTPS, JWT). 502: Modbus TCP server of the running program.
    publishablePorts: [8443, 502],
    allowedEnv: [],
    // The runtime compiles each uploaded program with g++; 256 MB is not enough for that.
    defaultLimits: { cpus: 1, memoryMb: 1024 },
  },
];
