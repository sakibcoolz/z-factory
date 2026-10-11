package device

import (
	"errors"
	"testing"
)

func types(events []Event, deviceID string) []string {
	var out []string
	for _, event := range events {
		if event.DeviceID == deviceID {
			out = append(out, event.Type)
		}
	}
	return out
}

func TestEveryProfileHasTheGenericOfflineFault(t *testing.T) {
	for _, key := range Profiles() {
		description, _ := Describe(key)
		last := description.Faults[len(description.Faults)-1]
		if last.Code != "OFFLINE" || !last.Silent || last.Latching || last.Severity != Critical {
			t.Errorf("%s: last fault %+v", key, last)
		}
		count := 0
		for _, fault := range description.Faults {
			if fault.Code == "OFFLINE" {
				count++
			}
		}
		if count != 1 {
			t.Errorf("%s: OFFLINE declared %d times", key, count)
		}
	}
	// A protocol device gains COMM_LOSS from its map; a hardwired one does not have it.
	vfd, _ := DescribeRegisterMap("VFD_MODBUS_TCP")
	if len(vfd.Faults) != 1 || vfd.Faults[0].Code != "COMM_LOSS" {
		t.Fatalf("map faults %+v", vfd.Faults)
	}
	if _, err := NewSimulation("f", []Config{config("v", "V", "VFD", nil, nil)}, Options{}); err != nil {
		t.Fatal(err)
	}
	hardwired := config("v", "V", "VFD", nil, nil)
	hardwired.Faults = map[string]FaultOverride{"COMM_LOSS": {}}
	_, err := NewSimulation("f", []Config{hardwired}, Options{})
	var refused *ConfigError
	if !errors.As(err, &refused) || refused.Rule != "supported-fault" {
		t.Fatalf("COMM_LOSS on a hardwired device: %v", err)
	}
	served := modbusDrive(1)
	served.Faults = map[string]FaultOverride{"COMM_LOSS": {}, "OFFLINE": {}}
	if _, err := NewSimulation("f", []Config{served}, Options{}); err != nil {
		t.Fatal(err)
	}
}

func TestAnUnavailableDeviceReadsDeEnergizedAndComesBackFromItsInitialState(t *testing.T) {
	s, err := NewSimulation("f", chain("", nil, nil, nil, nil), Options{})
	if err != nil {
		t.Fatal(err)
	}
	inputs(t, s, "vfd", Values{"run": 1, "frequencySetpoint": 50})
	run(t, s, 20)
	if got := outputs(t, s, "pump"); got["running"] != 1 || got["flow"] != 100 {
		t.Fatalf("pump before: %v", got)
	}
	if got := outputs(t, s, "pt"); got["value"] != 4 {
		t.Fatalf("transmitter before: %v", got)
	}
	// The drive loses its supply: it reads de-energized, the motor coasts, the pump
	// stops, the transmitter still measures the pump (which is powered) but the drive's
	// quality is BAD; nothing wrote a PLC output.
	if _, err := s.InjectFault("vfd", "OFFLINE"); err != nil {
		t.Fatal(err)
	}
	events, _ := s.Step(tick)
	if got := outputs(t, s, "vfd"); got["running"] != 0 || got["actualFrequency"] != 0 || got["faulted"] != 0 {
		t.Fatalf("offline drive: %v", got)
	}
	vfd, _ := s.Device("vfd")
	if snapshot := vfd.Snapshot(); snapshot.State != "OFFLINE" || snapshot.Quality != "BAD" || !snapshot.Faulted {
		t.Fatalf("offline snapshot: %+v", snapshot)
	}
	got := types(events, "vfd")
	if len(got) != 2 || got[0] != "QUALITY_CHANGED" || got[1] != "VFD_STATE_CHANGED" {
		t.Fatalf("offline events: %v", got)
	}
	run(t, s, 10)
	if got := outputs(t, s, "motor"); got["running"] != 0 || got["actualSpeed"] > 50 {
		t.Fatalf("motor after the drive went offline: %v", got)
	}
	if got := outputs(t, s, "pump"); got["running"] != 0 {
		t.Fatalf("pump after the drive went offline: %v", got)
	}
	// Inputs still land on the device (a PLC keeps commanding it) but do nothing.
	inputs(t, s, "vfd", Values{"run": 1, "frequencySetpoint": 50})
	run(t, s, 1)
	if got := outputs(t, s, "vfd"); got["actualFrequency"] != 0 {
		t.Fatalf("an offline drive does not ramp: %v", got)
	}
	// Power returns: the drive restarts from zero and ramps up again, quality GOOD.
	if _, err := s.ClearFault("vfd", "OFFLINE"); err != nil {
		t.Fatal(err)
	}
	events, _ = s.Step(tick)
	if got := types(events, "vfd"); len(got) != 2 || got[0] != "QUALITY_CHANGED" || got[1] != "VFD_STATE_CHANGED" {
		t.Fatalf("return events: %v", got)
	}
	if got := outputs(t, s, "vfd"); got["actualFrequency"] <= 0 || got["actualFrequency"] >= 50 {
		t.Fatalf("the drive ramps again from zero: %v", got)
	}
	if vfd.Snapshot().Quality != "GOOD" {
		t.Fatal("quality back to GOOD")
	}

	// A transmitter measuring an unavailable pump reads zero with BAD quality: quality
	// travels along the measures link; it is GOOD again when the pump is back.
	if _, err := s.InjectFault("pump", "OFFLINE"); err != nil {
		t.Fatal(err)
	}
	events, _ = s.Step(tick)
	pt, _ := s.Device("pt")
	if got := outputs(t, s, "pt"); got["value"] != 0 || pt.Snapshot().Quality != "BAD" {
		t.Fatalf("transmitter on an offline pump: %v %s", got, pt.Snapshot().Quality)
	}
	if got := types(events, "pt"); len(got) < 1 || got[0] != "QUALITY_CHANGED" {
		t.Fatalf("transmitter quality events: %v", got)
	}
	s.ClearFault("pump", "OFFLINE")
	run(t, s, 1)
	if pt.Snapshot().Quality != "GOOD" {
		t.Fatal("transmitter quality back to GOOD")
	}
	// An operator reset is not needed and not refused: OFFLINE does not latch.
	if _, err := s.Reset("vfd"); err != nil {
		t.Fatal(err)
	}
}

func TestATrippedDeviceThatGoesOfflineComesBackUntripped(t *testing.T) {
	s, err := NewSimulation("f", chain("", nil, nil, nil, nil), Options{})
	if err != nil {
		t.Fatal(err)
	}
	inputs(t, s, "vfd", Values{"run": 1, "frequencySetpoint": 50})
	run(t, s, 10)
	s.InjectFault("vfd", "OVERCURRENT")
	run(t, s, 1)
	s.ClearFault("vfd", "OVERCURRENT")
	run(t, s, 1)
	vfd, _ := s.Device("vfd")
	if !vfd.Snapshot().Tripped {
		t.Fatal("tripped after the cause is gone")
	}
	// A power cycle is the one thing besides a reset that ends a trip: the drive restarts.
	s.InjectFault("vfd", "OFFLINE")
	run(t, s, 1)
	s.ClearFault("vfd", "OFFLINE")
	run(t, s, 1)
	if snapshot := vfd.Snapshot(); snapshot.Tripped || snapshot.State != "ACCELERATING" {
		t.Fatalf("after the power cycle: %+v", snapshot)
	}
}

func TestLimitSwitchDisagreementIsSilentAndReadByThePlc(t *testing.T) {
	s, err := NewSimulation("f", []Config{config("xv", "XV", "VALVE", nil, nil)}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	run(t, s, 1)
	if got := outputs(t, s, "xv"); got["closed"] != 1 || got["opened"] != 0 {
		t.Fatalf("closed valve: %v", got)
	}
	s.InjectFault("xv", "LIMIT_SWITCH_FAULT")
	run(t, s, 1)
	if got := outputs(t, s, "xv"); got["closed"] != 1 || got["opened"] != 1 || got["faulted"] != 0 || got["position"] != 0 {
		t.Fatalf("disagreeing switches: %v", got)
	}
	xv, _ := s.Device("xv")
	if snapshot := xv.Snapshot(); !snapshot.Faulted || snapshot.Quality != "GOOD" {
		t.Fatalf("the fault is present but the value is trusted: %+v", snapshot)
	}
	s.ClearFault("xv", "LIMIT_SWITCH_FAULT")
	run(t, s, 1)
	if got := outputs(t, s, "xv"); got["opened"] != 0 {
		t.Fatalf("after clearing: %v", got)
	}

	cylinder, err := NewSimulation("f", []Config{config("cyl", "CYL", "ACTUATOR", nil, nil)}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	cylinder.InjectFault("cyl", "END_SENSOR_FAULT")
	run(t, cylinder, 1)
	if got := outputs(t, cylinder, "cyl"); got["extended"] != 1 || got["retracted"] != 1 {
		t.Fatalf("cylinder end sensors: %v", got)
	}
}
