package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sakibcoolz/z-factory/services/process-sim/internal/engine"
)

const token = "test-token-0123456789abcdef"

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	server, err := New(engine.New(log, 8), token, log)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Handler())
	t.Cleanup(ts.Close)
	return ts
}

func call(t *testing.T, ts *httptest.Server, method, path string, body any, auth bool) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	request, _ := http.NewRequest(method, ts.URL+path, reader)
	if auth {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := ts.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	if response.StatusCode != http.StatusNoContent {
		_ = json.NewDecoder(response.Body).Decode(&decoded)
	}
	return response.StatusCode, decoded
}

func tankConfig(id string) map[string]any {
	return map[string]any{
		"contractVersion": 1, "instanceId": id, "factoryId": "f-1", "moduleType": "TANK", "modelType": "TANK",
		"modelVersion": 1, "configVersion": 3, "tickMs": 1000, "clock": "manual",
		"parameters": map[string]float64{"volume": 40, "inflowRate": 3600, "valveTravelS": 1},
	}
}

func TestEverythingButHealthNeedsTheToken(t *testing.T) {
	ts := newServer(t)
	if status, body := call(t, ts, "GET", "/healthz", nil, false); status != 200 || body["status"] != "ok" || body["contractVersion"] != float64(1) {
		t.Fatalf("health: %d %v", status, body)
	}
	for _, route := range [][2]string{{"GET", "/metrics"}, {"GET", "/v1/instances"}, {"PUT", "/v1/instances/x"}, {"POST", "/v1/instances/x/start"}} {
		if status, body := call(t, ts, route[0], route[1], nil, false); status != 401 || body["code"] != "unauthorized" {
			t.Errorf("%s %s without token: %d", route[0], route[1], status)
		}
	}
	if _, err := New(engine.New(slog.New(slog.NewTextHandler(io.Discard, nil)), 1), "short", nil); err == nil {
		t.Fatal("a short token must not start the server")
	}
}

func TestLifecycleOverHttp(t *testing.T) {
	ts := newServer(t)
	status, loaded := call(t, ts, "PUT", "/v1/instances/tank-1", tankConfig("tank-1"), true)
	if status != 200 || loaded["status"] != "LOADED" || loaded["configVersion"] != float64(3) {
		t.Fatalf("load: %d %v", status, loaded)
	}
	if status, body := call(t, ts, "PUT", "/v1/instances/other", tankConfig("tank-1"), true); status != 400 || body["code"] != "bad-request" {
		t.Fatalf("mismatched id: %d %v", status, body)
	}
	bad := tankConfig("bad")
	bad["modelType"] = "BOILER"
	if status, body := call(t, ts, "PUT", "/v1/instances/bad", bad, true); status != 422 || body["code"] != "invalid-configuration" {
		t.Fatalf("bad model: %d %v", status, body)
	}
	if status, body := call(t, ts, "POST", "/v1/instances/tank-1/step?ticks=1", nil, true); status != 409 || body["code"] != "wrong-state" {
		t.Fatalf("step before start: %d %v", status, body)
	}

	call(t, ts, "POST", "/v1/instances/tank-1/start", nil, true)
	call(t, ts, "PUT", "/v1/instances/tank-1/inputs", map[string]float64{"INLET_VALVE_CMD": 1}, true)
	// 3600 m3/h is 1 m3/s and the valve opens within the first tick: after 10 s, 10 m3 of 40 = 25 %.
	status, stepped := call(t, ts, "POST", "/v1/instances/tank-1/step?ticks=10", nil, true)
	outputs := stepped["outputs"].(map[string]any)
	if status != 200 || stepped["tick"] != float64(10) || outputs["LEVEL"] != float64(25) {
		t.Fatalf("stepped: %d %v", status, stepped)
	}
	if status, body := call(t, ts, "PUT", "/v1/instances/tank-1/inputs", map[string]float64{"HEATER": 1}, true); status != 422 {
		t.Fatalf("unknown input: %d %v", status, body)
	}

	status, list := call(t, ts, "GET", "/v1/instances", nil, true)
	if status != 200 || len(list["instances"].([]any)) != 1 {
		t.Fatalf("list: %d %v", status, list)
	}
	if status, metrics := call(t, ts, "GET", "/metrics", nil, true); status != 200 || metrics["ticksTotal"] != float64(10) {
		t.Fatalf("metrics: %d %v", status, metrics)
	}
	if status, body := call(t, ts, "GET", "/v1/instances/tank-1/events", nil, true); status != 200 || body["events"] == nil {
		t.Fatalf("events: %d %v", status, body)
	}
	if status, reset := call(t, ts, "POST", "/v1/instances/tank-1/reset", nil, true); status != 200 || reset["tick"] != float64(0) || reset["status"] != "LOADED" {
		t.Fatalf("reset: %d %v", status, reset)
	}
	if status, _ := call(t, ts, "DELETE", "/v1/instances/tank-1", nil, true); status != 204 {
		t.Fatalf("unload: %d", status)
	}
	if status, body := call(t, ts, "GET", "/v1/instances/tank-1", nil, true); status != 404 || body["code"] != "not-found" {
		t.Fatalf("after unload: %d %v", status, body)
	}
	// A body with fields the contract does not know is refused, not silently accepted.
	request, _ := http.NewRequest("PUT", ts.URL+"/v1/instances/x", strings.NewReader(`{"contractVersion":1,"instanceId":"x","factoryId":"f","modelType":"TANK","modelVersion":1,"configVersion":1,"tickMs":100,"persistEveryTick":true}`))
	request.Header.Set("Authorization", "Bearer "+token)
	response, _ := ts.Client().Do(request)
	if response.StatusCode != 400 {
		t.Fatalf("unknown field: %d", response.StatusCode)
	}
}

func TestOverridesOverHttp(t *testing.T) {
	ts := newServer(t)
	if status, _ := call(t, ts, "PUT", "/v1/instances/t1", tankConfig("t1"), true); status != 200 {
		t.Fatalf("load: %d", status)
	}
	status, body := call(t, ts, "PUT", "/v1/instances/t1/overrides/LEVEL", map[string]any{"mode": "MANUAL_OVERRIDE", "value": 97, "source": "tester"}, true)
	if status != 200 || body["mode"] != "MANUAL_OVERRIDE" || body["effective"] != float64(97) {
		t.Fatalf("set: %d %v", status, body)
	}
	status, body = call(t, ts, "GET", "/v1/instances/t1", nil, true)
	if status != 200 || body["outputs"].(map[string]any)["LEVEL"] != float64(97) {
		t.Fatalf("inspect: %d %v", status, body)
	}
	status, body = call(t, ts, "GET", "/v1/instances/t1/overrides", nil, true)
	if status != 200 || len(body["signals"].([]any)) != 2 {
		t.Fatalf("list: %d %v", status, body)
	}
	if status, body = call(t, ts, "PUT", "/v1/instances/t1/overrides/INLET_VALVE_CMD", map[string]any{"mode": "MANUAL_OVERRIDE", "value": 1}, true); status != 422 || body["code"] != "invalid-configuration" {
		t.Fatalf("command: %d %v", status, body)
	}
	if status, _ = call(t, ts, "PUT", "/v1/instances/t1/overrides/LEVEL", map[string]any{"mode": "MANUAL_OVERRIDE", "value": 101}, true); status != 422 {
		t.Fatalf("range: %d", status)
	}
	if status, _ = call(t, ts, "PUT", "/v1/instances/t1/overrides/LEVEL", map[string]any{"mode": "MANUAL_OVERRIDE", "valu": 1}, true); status != 400 {
		t.Fatalf("unknown field: %d", status)
	}
	if status, _ = call(t, ts, "PUT", "/v1/instances/t1/overrides/NOPE", map[string]any{"mode": "MANUAL_OVERRIDE", "value": 1}, true); status != 404 {
		t.Fatalf("unknown signal: %d", status)
	}
	for range 2 {
		status, body = call(t, ts, "DELETE", "/v1/instances/t1/overrides/LEVEL?source=tester", nil, true)
		if status != 200 || body["mode"] != "AUTO" {
			t.Fatalf("clear: %d %v", status, body)
		}
	}
	if status, _ = call(t, ts, "DELETE", "/v1/instances/t1/overrides/LEVEL", nil, false); status != 401 {
		t.Fatalf("token: %d", status)
	}
}
