package runtime

import (
	"errors"
	"testing"
	"time"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/device"
	"github.com/sakibcoolz/z-factory/services/process-sim/internal/modbus"
)

// modbusChain is a Modbus-controlled drive feeding a motor, served on any free port.
func modbusChain(factoryID string, port int) Config {
	config := Config{
		ContractVersion: ContractVersion,
		FactoryID:       factoryID,
		ConfigVersion:   1,
		TickMs:          100,
		Clock:           ClockManual,
		ModbusTCP:       &ModbusTCPConfig{Port: port},
		Devices: []device.Config{
			{DeviceID: "vfd", Name: "VFD-01", Profile: "VFD", ProfileVersion: 1, Parameters: raw(map[string]any{"maxFrequencyHz": 60}),
				Protocol: &device.ProtocolConfig{Kind: device.ProtocolModbusTCP, UnitID: 3, RegisterMap: "VFD_MODBUS_TCP", RegisterMapVersion: 1}},
			{DeviceID: "motor", Name: "M-01", Profile: "MOTOR", ProfileVersion: 1, Links: map[string]string{"drive": "vfd"}},
		},
	}
	return config
}

func expectException(t *testing.T, err error, code byte) {
	t.Helper()
	var exception modbus.Exception
	if !errors.As(err, &exception) || byte(exception) != code {
		t.Fatalf("expected exception %02x, got %v", code, err)
	}
}

func TestServesProtocolDevicesOverModbusTCP(t *testing.T) {
	r := New(quiet(), 64, device.Options{})
	t.Cleanup(r.Shutdown)
	loaded := snap(t)(r.Load(modbusChain("f", 0)))
	if loaded.ModbusTCP == nil || loaded.ModbusTCP.Port == 0 || loaded.ModbusTCP.Devices != 1 {
		t.Fatalf("listener: %+v", loaded.ModbusTCP)
	}
	client := modbus.Client{Address: loaded.ModbusTCP.Address, Unit: 3, Timeout: 2 * time.Second}

	// Feedback of a stopped drive, and its commands as not yet written.
	if bits, err := client.ReadBits(modbus.DiscreteInput, 0, 3); err != nil || bits[0] || bits[1] || bits[2] {
		t.Fatalf("feedback at rest: %v %v", bits, err)
	}
	if coils, err := client.ReadBits(modbus.Coil, 0, 3); err != nil || coils[0] {
		t.Fatalf("coils at rest: %v %v", coils, err)
	}
	// A write sets the behaviour's inputs: run and a 45.0 Hz setpoint.
	if err := client.WriteCoil(0, true); err != nil {
		t.Fatal(err)
	}
	if err := client.WriteRegister(0, 450); err != nil {
		t.Fatal(err)
	}
	// Refusals answer the exception the gateway endpoint uses, and touch nothing.
	expectException(t, client.WriteRegister(0, 650), modbus.IllegalDataValue)
	expectException(t, client.WriteRegister(1, 1), modbus.IllegalDataAddress)
	expectException(t, client.WriteCoils(2, []bool{true, true}), modbus.IllegalDataAddress)
	_, err := client.ReadRegisters(modbus.InputRegister, 2, 1)
	expectException(t, err, modbus.IllegalDataAddress)
	other := client
	other.Unit = 4
	_, err = other.ReadBits(modbus.Coil, 0, 1)
	expectException(t, err, modbus.GatewayPathUnavailable)
	if vfd := dev(t)(r.Device("f", "vfd")); vfd.Inputs["run"] != 1 || vfd.Inputs["frequencySetpoint"] != 45 || vfd.Protocol == nil || vfd.Protocol.UnitID != 3 {
		t.Fatalf("inputs after the writes: %+v", vfd)
	}

	snap(t)(r.Start("f"))
	snap(t)(r.Step("f", 100))
	inputs, _ := client.ReadBits(modbus.DiscreteInput, 0, 3)
	registers, _ := client.ReadRegisters(modbus.InputRegister, 0, 2)
	holding, _ := client.ReadRegisters(modbus.HoldingRegister, 0, 1)
	if !inputs[0] || !inputs[1] || inputs[2] || registers[0] != 450 || registers[1] == 0 || holding[0] != 450 {
		t.Fatalf("after 10 s: %v %v %v", inputs, registers, holding)
	}
	if motor := dev(t)(r.Device("f", "motor")); motor.Outputs["running"] != 1 {
		t.Fatalf("the motor follows the drive: %v", motor.Outputs)
	}
	// A reversal through the coil, read back by the drive's own state.
	if err := client.WriteCoils(0, []bool{true, true}); err != nil {
		t.Fatal(err)
	}
	snap(t)(r.Step("f", 50))
	if registers, _ := client.ReadRegisters(modbus.InputRegister, 0, 1); registers[0] >= 450 {
		t.Fatalf("reversing: %v", registers)
	}

	// Events: every changed command, a refusal once per address in 30 s.
	events := evs(t)(r.Events("f", 0))
	writes, rejected := 0, 0
	for _, event := range events {
		switch event.Type {
		case "PROTOCOL_WRITE":
			writes++
		case "PROTOCOL_WRITE_REJECTED":
			rejected++
		}
	}
	if writes != 3 || rejected != 3 {
		t.Fatalf("events: %d writes, %d rejected: %v", writes, rejected, events)
	}
	expectException(t, client.WriteRegister(0, 650), modbus.IllegalDataValue)
	if again := evs(t)(r.Events("f", 0)); len(again) != len(events) {
		t.Fatalf("a repeated refusal is not recorded again within 30 s: %d", len(again))
	}

	// Communication lost (TASK-1014): the device answers nothing for its unit id, its quality
	// is BAD, its behaviour goes on; back when the fault is cleared.
	dev(t)(r.InjectFault("f", "vfd", "COMM_LOSS"))
	_, err = client.ReadBits(modbus.Coil, 0, 1)
	expectException(t, err, modbus.GatewayTargetFailed)
	expectException(t, client.WriteCoil(0, true), modbus.GatewayTargetFailed)
	snap(t)(r.Step("f", 10))
	if vfd := dev(t)(r.Device("f", "vfd")); vfd.Quality != "BAD" || vfd.Outputs["running"] != 1 {
		t.Fatalf("unreachable drive: %+v", vfd)
	}
	dev(t)(r.ClearFault("f", "vfd", "COMM_LOSS"))
	snap(t)(r.Step("f", 1))
	if _, err := client.ReadBits(modbus.Coil, 0, 1); err != nil {
		t.Fatalf("answers again: %v", err)
	}
	if vfd := dev(t)(r.Device("f", "vfd")); vfd.Quality != "GOOD" {
		t.Fatalf("quality back: %+v", vfd)
	}

	// Unloading closes the listener; loading again opens it.
	if err := r.Unload("f"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.ReadBits(modbus.Coil, 0, 1); err == nil {
		t.Fatal("the listener should be closed")
	}
	reloaded := snap(t)(r.Load(modbusChain("f", 0)))
	if reloaded.ModbusTCP == nil {
		t.Fatal("no listener after loading again")
	}
}

func TestProtocolRules(t *testing.T) {
	r := New(quiet(), 64, device.Options{})
	t.Cleanup(r.Shutdown)
	if err := r.ConfigureModbus(ModbusOptions{Bind: "127.0.0.1", MinPort: 17000, MaxPort: 17009}); err != nil {
		t.Fatal(err)
	}
	if err := r.ConfigureModbus(ModbusOptions{Bind: "", MinPort: 1, MaxPort: 2}); err == nil {
		t.Fatal("an empty bind address is refused")
	}
	// Protocol devices need a listener; a listener's port is one of the range.
	noListener := modbusChain("f", 0)
	noListener.ModbusTCP = nil
	_, err := r.Load(noListener)
	expectRule(t, err, "modbus-listener")
	_, err = r.Load(modbusChain("f", 9))
	expectRule(t, err, "modbus-port")
	// A listener without protocol devices is allowed; a protocol device cannot join a
	// factory without one; two devices cannot share a unit id.
	plain := chain("plain", ClockManual)
	snap(t)(r.Load(plain))
	_, err = r.Upsert("plain", modbusChain("x", 0).Devices[0])
	expectRule(t, err, "modbus-listener")
	snap(t)(r.Load(modbusChain("f", 0)))
	twin := modbusChain("f", 0).Devices[0]
	twin.DeviceID, twin.Name = "vfd2", "VFD-02"
	_, err = r.Upsert("f", twin)
	expectRule(t, err, "unique-unit-id")
	twin.Protocol.UnitID = 4
	snap(t)(r.Upsert("f", twin))
	if inspected := snap(t)(r.Inspect("f")); inspected.ModbusTCP.Devices != 2 {
		t.Fatalf("served devices: %+v", inspected.ModbusTCP)
	}
	// A port in use answers modbus-listen and leaves the runtime consistent.
	port := snap(t)(r.Inspect("f")).ModbusTCP.Port
	if err := r.ConfigureModbus(ModbusOptions{Bind: "127.0.0.1", MinPort: port, MaxPort: port}); err != nil {
		t.Fatal(err)
	}
	_, err = r.Load(modbusChain("g", port))
	expectRule(t, err, "modbus-listen")
	if _, err := r.Inspect("g"); !errors.Is(err, ErrNotFound) {
		t.Fatal("a factory whose listener failed is not kept")
	}
	if inspected := snap(t)(r.Inspect("f")); inspected.ModbusTCP.Port != port {
		t.Fatal("the other factory keeps its listener")
	}
}
