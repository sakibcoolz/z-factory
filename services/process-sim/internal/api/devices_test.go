package api

import (
	"net/http"
	"testing"
)

func factoryConfig(id string) map[string]any {
	return map[string]any{
		"contractVersion": 1, "factoryId": id, "configVersion": 2, "tickMs": 100, "clock": "manual",
		"devices": []map[string]any{
			{"deviceId": "vfd", "name": "VFD-01", "profile": "VFD", "profileVersion": 1, "inputs": map[string]float64{"run": 1, "frequencySetpoint": 50}},
			{"deviceId": "motor", "name": "M-01", "profile": "MOTOR", "profileVersion": 1, "links": map[string]string{"drive": "vfd"}},
			{"deviceId": "pump", "name": "P-01", "profile": "PUMP", "profileVersion": 1, "links": map[string]string{"motor": "motor"}},
			{"deviceId": "pt", "name": "PT-01", "profile": "SENSOR", "profileVersion": 1, "links": map[string]string{"measures": "pump"},
				"parameters": map[string]any{"source": map[string]any{"kind": "MEASURED", "signal": "pressure"}}},
		},
	}
}

func TestDeviceRoutesNeedTheTokenAndDescribeTheProfiles(t *testing.T) {
	ts := newServer(t)
	for _, route := range [][2]string{{"GET", "/v1/profiles"}, {"GET", "/v1/factories"}, {"PUT", "/v1/factories/f"}, {"POST", "/v1/factories/f/start"}} {
		if status, body := call(t, ts, route[0], route[1], nil, false); status != 401 || body["code"] != "unauthorized" {
			t.Errorf("%s %s without token: %d", route[0], route[1], status)
		}
	}
	status, health := call(t, ts, "GET", "/healthz", nil, false)
	if status != 200 || health["deviceContractVersion"] != float64(1) || health["factories"] != float64(0) || len(health["profiles"].([]any)) < 10 {
		t.Fatalf("health: %d %v", status, health)
	}
	status, profiles := call(t, ts, "GET", "/v1/profiles", nil, true)
	if status != 200 || len(profiles["profiles"].([]any)) < 10 {
		t.Fatalf("profiles: %d %v", status, profiles)
	}
	status, vfd := call(t, ts, "GET", "/v1/profiles/VFD", nil, true)
	if status != 200 || vfd["key"] != "VFD" || vfd["version"] != float64(1) || len(vfd["signals"].([]any)) != 9 {
		t.Fatalf("VFD: %d %v", status, vfd)
	}
	if status, _ := call(t, ts, "GET", "/v1/profiles/BOILER", nil, true); status != 404 {
		t.Fatalf("unknown profile: %d", status)
	}
	// The declared register maps (TASK-1013).
	if maps, ok := health["registerMaps"].([]any); !ok || len(maps) != 1 || maps[0] != "VFD_MODBUS_TCP" {
		t.Fatalf("health register maps: %v", health["registerMaps"])
	}
	status, maps := call(t, ts, "GET", "/v1/register-maps", nil, true)
	if status != 200 || len(maps["registerMaps"].([]any)) != 1 {
		t.Fatalf("register maps: %d %v", status, maps)
	}
	status, vfdMap := call(t, ts, "GET", "/v1/register-maps/VFD_MODBUS_TCP", nil, true)
	if status != 200 || vfdMap["profile"] != "VFD" || vfdMap["protocol"] != "MODBUS_TCP" || len(vfdMap["registers"].([]any)) != 9 {
		t.Fatalf("VFD map: %d %v", status, vfdMap)
	}
	if status, _ := call(t, ts, "GET", "/v1/register-maps/PUMP_MODBUS", nil, true); status != 404 {
		t.Fatalf("unknown map: %d", status)
	}
	// A factory with a protocol device is served; the summary says where.
	served := factoryConfig("served")
	served["modbusTcp"] = map[string]any{"port": 0}
	served["devices"].([]map[string]any)[0]["protocol"] = map[string]any{"kind": "MODBUS_TCP", "unitId": 1, "registerMap": "VFD_MODBUS_TCP", "registerMapVersion": 1}
	status, loaded := call(t, ts, "PUT", "/v1/factories/served", served, true)
	if status != 200 || loaded["modbusTcp"].(map[string]any)["devices"] != float64(1) || loaded["modbusTcp"].(map[string]any)["port"] == float64(0) {
		t.Fatalf("served factory: %d %v", status, loaded)
	}
	served["modbusTcp"] = nil
	if status, body := call(t, ts, "PUT", "/v1/factories/served", served, true); status != 422 || body["rule"] != "modbus-listener" {
		t.Fatalf("without a listener: %d %v", status, body)
	}
	call(t, ts, "DELETE", "/v1/factories/served", nil, true)
}

func TestFactoryLifecycleOverHttp(t *testing.T) {
	ts := newServer(t)
	status, loaded := call(t, ts, "PUT", "/v1/factories/f-1", factoryConfig("f-1"), true)
	if status != 200 || loaded["status"] != "LOADED" || loaded["deviceCount"] != float64(4) || len(loaded["devices"].([]any)) != 4 {
		t.Fatalf("load: %d %v", status, loaded)
	}
	if status, body := call(t, ts, "PUT", "/v1/factories/other", factoryConfig("f-1"), true); status != 400 || body["code"] != "bad-request" {
		t.Fatalf("mismatched id: %d %v", status, body)
	}
	bad := factoryConfig("bad")
	bad["devices"].([]map[string]any)[1]["links"] = map[string]string{"drive": "pump"}
	if status, body := call(t, ts, "PUT", "/v1/factories/bad", bad, true); status != 422 || body["code"] != "invalid-configuration" || body["rule"] != "drive" {
		t.Fatalf("bad link: %d %v", status, body)
	}
	if status, body := call(t, ts, "POST", "/v1/factories/f-1/step?ticks=1", nil, true); status != 409 || body["code"] != "wrong-state" || body["rule"] != "factory-state" {
		t.Fatalf("step before start: %d %v", status, body)
	}

	call(t, ts, "POST", "/v1/factories/f-1/start", nil, true)
	status, stepped := call(t, ts, "POST", "/v1/factories/f-1/step?ticks=100", nil, true)
	if status != 200 || stepped["tick"] != float64(100) {
		t.Fatalf("stepped: %d %v", status, stepped)
	}
	status, pump := call(t, ts, "GET", "/v1/factories/f-1/devices/pump", nil, true)
	if status != 200 || pump["outputs"].(map[string]any)["flow"] != float64(100) || pump["status"] != "OK" {
		t.Fatalf("pump: %d %v", status, pump)
	}
	status, pt := call(t, ts, "GET", "/v1/factories/f-1/devices/pt", nil, true)
	if status != 200 || pt["outputs"].(map[string]any)["value"] != float64(4) {
		t.Fatalf("transmitter: %d %v", status, pt)
	}

	// Inputs, faults, forcing, reset.
	if status, body := call(t, ts, "PUT", "/v1/factories/f-1/devices/vfd/inputs", map[string]float64{"flow": 1}, true); status != 422 || body["rule"] != "input-signal" {
		t.Fatalf("unknown input: %d %v", status, body)
	}
	if status, _ := call(t, ts, "PUT", "/v1/factories/f-1/devices/vfd/inputs", map[string]float64{"run": 0}, true); status != 200 {
		t.Fatalf("inputs: %d", status)
	}
	if status, body := call(t, ts, "POST", "/v1/factories/f-1/devices/vfd/faults/OVERCURRENT", nil, true); status != 200 || body["activeFaults"].([]any)[0] != "OVERCURRENT" {
		t.Fatalf("inject: %d %v", status, body)
	}
	if status, body := call(t, ts, "POST", "/v1/factories/f-1/devices/vfd/faults/OVERCURRENT", nil, true); status != 409 || body["rule"] != "fault-active" {
		t.Fatalf("inject twice: %d %v", status, body)
	}
	if status, body := call(t, ts, "POST", "/v1/factories/f-1/devices/vfd/faults/DRY_RUN", nil, true); status != 422 || body["rule"] != "supported-fault" {
		t.Fatalf("unsupported fault: %d %v", status, body)
	}
	call(t, ts, "POST", "/v1/factories/f-1/step?ticks=1", nil, true)
	if status, body := call(t, ts, "POST", "/v1/factories/f-1/devices/vfd/reset", nil, true); status != 409 || body["rule"] != "fault-active" {
		t.Fatalf("reset with the cause: %d %v", status, body)
	}
	call(t, ts, "DELETE", "/v1/factories/f-1/devices/vfd/faults/OVERCURRENT", nil, true)
	if status, body := call(t, ts, "POST", "/v1/factories/f-1/devices/vfd/reset", nil, true); status != 200 || body["tripped"] != false {
		t.Fatalf("reset: %d %v", status, body)
	}
	if status, body := call(t, ts, "PUT", "/v1/factories/f-1/devices/pt/force", map[string]any{"value": 7.5}, true); status != 200 || body["forced"] != float64(7.5) {
		t.Fatalf("force: %d %v", status, body)
	}
	if status, body := call(t, ts, "PUT", "/v1/factories/f-1/devices/pump/force", map[string]any{"value": 1}, true); status != 422 || body["rule"] != "forcible-device" {
		t.Fatalf("force a pump: %d %v", status, body)
	}
	if status, body := call(t, ts, "DELETE", "/v1/factories/f-1/devices/pt/force", nil, true); status != 200 || body["forced"] != nil {
		t.Fatalf("release: %d %v", status, body)
	}

	// A device joins and leaves; a linked one stays; a missing one is 404.
	if status, body := call(t, ts, "PUT", "/v1/factories/f-1/devices/xv", map[string]any{"name": "XV-01", "profile": "VALVE", "profileVersion": 1}, true); status != 200 || body["deviceCount"] != float64(5) {
		t.Fatalf("upsert: %d %v", status, body)
	}
	if status, body := call(t, ts, "DELETE", "/v1/factories/f-1/devices/motor", nil, true); status != 409 || body["rule"] != "linked-device" {
		t.Fatalf("remove linked: %d %v", status, body)
	}
	if status, body := call(t, ts, "DELETE", "/v1/factories/f-1/devices/xv", nil, true); status != 200 || body["deviceCount"] != float64(4) {
		t.Fatalf("remove: %d %v", status, body)
	}
	if status, body := call(t, ts, "GET", "/v1/factories/f-1/devices/xv", nil, true); status != 404 || body["code"] != "not-found" {
		t.Fatalf("missing device: %d %v", status, body)
	}

	status, events := call(t, ts, "GET", "/v1/factories/f-1/events?after=0", nil, true)
	if status != 200 || len(events["events"].([]any)) < 5 {
		t.Fatalf("events: %d %v", status, events)
	}
	status, metrics := call(t, ts, "GET", "/metrics", nil, true)
	devices := metrics["devices"].(map[string]any)
	if status != 200 || devices["factories"] != float64(1) || devices["devices"] != float64(4) || devices["ticksTotal"] != float64(101) {
		t.Fatalf("metrics: %d %v", status, metrics)
	}
	status, list := call(t, ts, "GET", "/v1/factories", nil, true)
	if status != 200 || len(list["factories"].([]any)) != 1 {
		t.Fatalf("list: %d %v", status, list)
	}
	if status, reset := call(t, ts, "POST", "/v1/factories/f-1/reset", nil, true); status != 200 || reset["tick"] != float64(0) || reset["status"] != "LOADED" {
		t.Fatalf("reset: %d %v", status, reset)
	}
	if status, _ := call(t, ts, "DELETE", "/v1/factories/f-1", nil, true); status != http.StatusNoContent {
		t.Fatalf("unload: %d", status)
	}
	if status, body := call(t, ts, "GET", "/v1/factories/f-1", nil, true); status != 404 || body["code"] != "not-found" {
		t.Fatalf("after unload: %d %v", status, body)
	}
}
