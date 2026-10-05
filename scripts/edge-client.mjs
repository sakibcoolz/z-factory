#!/usr/bin/env node
/**
 * A small Modbus TCP client that stands in for an edge gateway (docs/demo-runbook.md).
 * It knows only what an edge device is given: the register map downloaded from the
 * Gateways screen. It needs Node.js 18 or later and nothing else, so it also runs on a
 * Raspberry Pi.
 *
 *   node scripts/edge-client.mjs <map.json> read [name...]
 *   node scripts/edge-client.mjs <map.json> write <name> <value>
 *   node scripts/edge-client.mjs <map.json> watch [seconds]
 *
 * Names are the ones in the map. Values are engineering values (45.5, true, false); the
 * client converts them with the scale and offset of the map.
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";

const EXCEPTIONS = {
  1: "the endpoint does not offer this function",
  2: "not mapped to this gateway, or mapped for reading only",
  3: "the value is not one the tag can hold",
  4: "the endpoint failed",
  10: "wrong unit id",
  11: "the PLC does not answer (is the factory started?)",
};
const READ_FUNCTION = { COIL: 1, DISCRETE_INPUT: 2, HOLDING_REGISTER: 3, INPUT_REGISTER: 4 };

const [mapPath, command, ...rest] = process.argv.slice(2);
if (!mapPath || !["read", "write", "watch"].includes(command ?? "")) {
  console.error("usage: edge-client.mjs <map.json> read [name...] | write <name> <value> | watch [seconds]");
  process.exit(2);
}
const map = JSON.parse(readFileSync(mapPath, "utf8"));
if (map.schema !== "z-factory.gateway-map") {
  console.error("This is not a register map from the Gateways screen.");
  process.exit(2);
}
const { host, port, unitId } = map.endpoint;
let transaction = 0;

/** One request, one connection: what many simple gateways do. */
function request(pdu) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const fail = (message) => {
      socket.destroy();
      reject(new Error(message));
    };
    socket.setTimeout(5000, () => fail(`no answer from ${host}:${port}`));
    socket.on("error", (error) => fail(`cannot reach ${host}:${port} (${error.code ?? error.message})`));
    socket.on("connect", () => {
      transaction = (transaction + 1) & 0xffff;
      socket.write(Buffer.from([transaction >> 8, transaction & 0xff, 0, 0, 0, pdu.length + 1, unitId, ...pdu]));
    });
    socket.on("data", (data) => {
      socket.destroy();
      const code = data[7];
      if (code & 0x80) reject(new Error(EXCEPTIONS[data[8]] ?? `Modbus exception ${data[8]}`));
      else resolve(data.subarray(8));
    });
  });
}

const word = (value) => [(value >> 8) & 0xff, value & 0xff];
const isBit = (register) => register.area === "COIL" || register.area === "DISCRETE_INPUT";

function find(name) {
  const register = map.registers.find((entry) => entry.name === name || entry.tag === name);
  if (!register) throw new Error(`"${name}" is not in the register map.`);
  return register;
}

/** The engineering value of a register: raw x scale + offset, signed for INT16. */
async function read(register) {
  const body = await request([READ_FUNCTION[register.area], ...word(register.address), ...word(register.wordCount)]);
  if (isBit(register)) return (body[1] & 1) === 1;
  if (register.wordCount !== 1)
    throw new Error(`${register.name}: values of ${register.wordCount} words are not read by this client.`);
  let raw = body.readUInt16BE(1);
  if (register.dataType === "INT16" && raw > 0x7fff) raw -= 0x10000;
  return Number((raw * register.scale + register.offset).toFixed(4));
}

async function write(register, text) {
  if (register.access !== "READ_WRITE") console.error(`note: the map gives ${register.name} for reading only.`);
  if (isBit(register)) {
    if (!["true", "false", "1", "0", "on", "off"].includes(text.toLowerCase())) throw new Error("Use true or false.");
    const on = ["true", "1", "on"].includes(text.toLowerCase());
    await request([5, ...word(register.address), on ? 0xff : 0, 0]);
    return on;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error("Use a number.");
  const raw = Math.round((value - register.offset) / register.scale);
  await request([6, ...word(register.address), ...word(raw & 0xffff)]);
  return value;
}

const show = (register, value) =>
  `${register.name.padEnd(22)} ${String(value).padStart(8)} ${(register.unit ?? "").padEnd(4)} ${register.role.toLowerCase().padEnd(14)} ${
    register.access === "READ_WRITE" ? "read and write" : "read"
  }`;

async function readAll(names) {
  const registers = names.length > 0 ? names.map(find) : map.registers;
  for (const register of registers) {
    try {
      console.log(show(register, await read(register)));
    } catch (error) {
      console.log(`${register.name.padEnd(22)} ${"-".padStart(8)}      ${error.message}`);
    }
  }
}

try {
  if (command === "read") {
    console.log(`${map.gateway} -> ${map.plc} at ${host}:${port}, unit ${unitId}`);
    await readAll(rest);
  } else if (command === "write") {
    const [name, value] = rest;
    if (!name || value === undefined) throw new Error("write <name> <value>");
    const register = find(name);
    console.log(
      `${register.name} <- ${await write(register, value)}: the PLC took the value. What happens next is PLC logic's decision.`,
    );
  } else {
    const until = Date.now() + Number(rest[0] ?? 30) * 1000;
    const registers = map.registers.filter((register) => register.wordCount === 1);
    console.log(registers.map((register) => register.name).join("  "));
    while (Date.now() < until) {
      const values = [];
      for (const register of registers) values.push(String(await read(register)).padStart(register.name.length));
      console.log(values.join("  "));
      await new Promise((resolve) => setTimeout(resolve, map.pollIntervalMs));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
