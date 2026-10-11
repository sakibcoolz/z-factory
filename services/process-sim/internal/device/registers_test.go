package device

import (
	"errors"
	"testing"
)

func modbusDrive(unit int) Config {
	return Config{
		DeviceID: "vfd", Name: "VFD-01", Profile: "VFD", ProfileVersion: 1,
		Parameters: mustJSON(map[string]any{"maxFrequencyHz": 60}),
		Protocol:   &ProtocolConfig{Kind: ProtocolModbusTCP, UnitID: unit, RegisterMap: "VFD_MODBUS_TCP", RegisterMapVersion: 1},
	}
}

func TestDeclaredMapsFitTheirProfiles(t *testing.T) {
	if maps := RegisterMaps(); len(maps) != 1 || maps[0] != "VFD_MODBUS_TCP" {
		t.Fatalf("maps: %v", maps)
	}
	vfd, err := DescribeRegisterMap("VFD_MODBUS_TCP")
	if err != nil || vfd.Profile != "VFD" || vfd.ProfileVersion != 1 || len(vfd.Registers) != 9 {
		t.Fatalf("VFD map: %v %v", vfd, err)
	}
	if vfd.Conventions != modbusConventions {
		t.Fatalf("conventions: %v", vfd.Conventions)
	}
	// Every signal of the profile is served, each in the area its direction and kind dictate.
	description, _ := Describe("VFD")
	for _, signal := range description.Signals {
		var found *RegisterSpec
		for index := range vfd.Registers {
			if vfd.Registers[index].Signal == signal.Key {
				found = &vfd.Registers[index]
			}
		}
		if found == nil {
			t.Fatalf("%s is not mapped", signal.Key)
		}
		writable := signal.Direction == In
		if (found.Access == "READ_WRITE") != writable || isBitArea(found.Area) != (signal.Kind == Bool) {
			t.Fatalf("%s: %v", signal.Key, *found)
		}
	}
	// A map that does not fit its profile is refused when declared.
	for name, broken := range map[string]RegisterMap{
		"unknown signal":     {Key: "X", Version: 1, Protocol: ProtocolModbusTCP, Profile: "VFD", ProfileVersion: 1, Registers: []RegisterSpec{{Signal: "flow", Area: InputRegister, DataType: "UINT16", WordCount: 1, Scale: 1, Access: "READ_ONLY", Role: "FEEDBACK"}}},
		"feedback as a coil": {Key: "X", Version: 1, Protocol: ProtocolModbusTCP, Profile: "VFD", ProfileVersion: 1, Registers: []RegisterSpec{{Signal: "running", Area: Coil, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_WRITE", Role: "COMMAND"}}},
		"command read-only":  {Key: "X", Version: 1, Protocol: ProtocolModbusTCP, Profile: "VFD", ProfileVersion: 1, Registers: []RegisterSpec{{Signal: "run", Area: Coil, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_ONLY", Role: "STATUS"}}},
		"address twice": {Key: "X", Version: 1, Protocol: ProtocolModbusTCP, Profile: "VFD", ProfileVersion: 1, Registers: []RegisterSpec{
			{Signal: "run", Area: Coil, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_WRITE", Role: "COMMAND"},
			{Signal: "reverse", Area: Coil, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_WRITE", Role: "COMMAND"},
		}},
		"range on feedback": {Key: "X", Version: 1, Protocol: ProtocolModbusTCP, Profile: "VFD", ProfileVersion: 1, Registers: []RegisterSpec{{Signal: "actualFrequency", Area: InputRegister, DataType: "UINT16", WordCount: 1, Scale: 1, Access: "READ_ONLY", Role: "FEEDBACK", Range: &RegisterRange{Min: f64(0)}}}},
		"unknown parameter": {Key: "X", Version: 1, Protocol: ProtocolModbusTCP, Profile: "VFD", ProfileVersion: 1, Registers: []RegisterSpec{{Signal: "frequencySetpoint", Area: HoldingRegister, DataType: "UINT16", WordCount: 1, Scale: 1, Access: "READ_WRITE", Role: "SETPOINT", Range: &RegisterRange{MaxParameter: "ratedFlow"}}}},
		"other protocol":    {Key: "X", Version: 1, Protocol: "PROFINET", Profile: "VFD", ProfileVersion: 1, Registers: []RegisterSpec{{Signal: "run", Area: Coil, DataType: "BOOL", WordCount: 1, Scale: 1, Access: "READ_WRITE", Role: "COMMAND"}}},
		"two words":         {Key: "X", Version: 1, Protocol: ProtocolModbusTCP, Profile: "VFD", ProfileVersion: 1, Registers: []RegisterSpec{{Signal: "frequencySetpoint", Area: HoldingRegister, DataType: "UINT16", WordCount: 2, Scale: 1, Access: "READ_WRITE", Role: "SETPOINT"}}},
	} {
		if err := checkRegisterMap(broken); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestProtocolDevicesAreValidatedAndServedByTheirMap(t *testing.T) {
	// Refusals name their rule.
	for name, config := range map[string]Config{
		"other protocol": func() Config { c := modbusDrive(1); c.Protocol.Kind = "PROFINET"; return c }(),
		"unit id 0":      modbusDrive(0),
		"unit id 248":    modbusDrive(248),
		"unknown map":    func() Config { c := modbusDrive(1); c.Protocol.RegisterMap = "PUMP_MODBUS"; return c }(),
		"wrong version":  func() Config { c := modbusDrive(1); c.Protocol.RegisterMapVersion = 2; return c }(),
		"other profile":  func() Config { c := modbusDrive(1); c.Profile = "MOTOR"; return c }(),
	} {
		_, err := NewSimulation("f", []Config{config}, Options{})
		var refused *ConfigError
		if !errors.As(err, &refused) {
			t.Errorf("%s: accepted", name)
		}
	}
	rule := func(t *testing.T, err error, want string) {
		t.Helper()
		var refused *ConfigError
		if !errors.As(err, &refused) || refused.Rule != want {
			t.Fatalf("expected rule %s, got %v", want, err)
		}
	}
	_, err := NewSimulation("f", []Config{modbusDrive(5)}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	other := modbusDrive(5)
	other.DeviceID, other.Name = "vfd2", "VFD-02"
	_, err = NewSimulation("f", []Config{modbusDrive(5), other}, Options{})
	rule(t, err, "unique-unit-id")

	sim, err := NewSimulation("f", []Config{
		modbusDrive(1),
		{DeviceID: "motor", Name: "M-01", Profile: "MOTOR", ProfileVersion: 1, Links: map[string]string{"drive": "vfd"}},
	}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if units := sim.ProtocolUnits(); len(units) != 1 || units[1] != "vfd" {
		t.Fatalf("units: %v", units)
	}
	if snapshot, _ := sim.Device("vfd"); snapshot.Snapshot().Protocol == nil || snapshot.Snapshot().Protocol.UnitID != 1 {
		t.Fatal("the snapshot carries the protocol")
	}
	// A device without a protocol has no registers.
	if _, err := sim.ReadBits("motor", Coil, 0, 1); !errors.Is(err, ErrNoProtocol) {
		t.Fatalf("motor: %v", err)
	}
	// Writes land on the profile's inputs, within range; reads give commands back and feedback scaled.
	if written, err := sim.WriteBits("vfd", 0, []bool{true, false}); err != nil || len(written) != 2 || !written[0].Changed || written[0].Signal != "run" {
		t.Fatalf("coils: %v %v", written, err)
	}
	if _, err := sim.WriteRegisters("vfd", 0, []uint16{450}); err != nil {
		t.Fatal(err)
	}
	if _, err := sim.WriteRegisters("vfd", 0, []uint16{601}); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("above maxFrequencyHz: %v", err)
	}
	if _, err := sim.WriteRegisters("vfd", 1, []uint16{1}); !errors.Is(err, ErrUnmapped) {
		t.Fatalf("unmapped holding register: %v", err)
	}
	if _, err := sim.WriteBits("vfd", 2, []bool{true, true}); !errors.Is(err, ErrUnmapped) {
		t.Fatalf("coils beyond the map: %v", err)
	}
	if _, err := sim.ReadBits("vfd", DiscreteInput, 3, 1); !errors.Is(err, ErrUnmapped) {
		t.Fatalf("unmapped discrete input: %v", err)
	}
	for i := 0; i < 100; i++ {
		if _, err := sim.Step(0.1); err != nil {
			t.Fatal(err)
		}
	}
	coils, _ := sim.ReadBits("vfd", Coil, 0, 3)
	holding, _ := sim.ReadRegisters("vfd", HoldingRegister, 0, 1)
	inputs, _ := sim.ReadBits("vfd", DiscreteInput, 0, 3)
	registers, _ := sim.ReadRegisters("vfd", InputRegister, 0, 2)
	if !coils[0] || coils[1] || coils[2] || holding[0] != 450 {
		t.Fatalf("commands read back: %v %v", coils, holding)
	}
	if !inputs[0] || !inputs[1] || inputs[2] || registers[0] != 450 || registers[1] == 0 {
		t.Fatalf("feedback after 10 s at 45 Hz: %v %v", inputs, registers)
	}
	// A written value is the same input the hardwired drive takes.
	if snapshot, _ := sim.Device("vfd"); snapshot.Snapshot().Inputs["frequencySetpoint"] != 45 || snapshot.Snapshot().Outputs["actualFrequency"] != 45 {
		t.Fatalf("inputs: %v", snapshot.Snapshot())
	}
}
