package config_test

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/testkit"
)

func TestAcceptsAnExportedFileCompactOrPretty(t *testing.T) {
	for _, indent := range []bool{false, true} {
		deployment, err := config.Parse(testkit.File("plc-1", "PLC-01", "127.0.0.1", 502, testkit.Options{Version: 7, Indent: indent}))
		if err != nil {
			t.Fatalf("indent %v: %v", indent, err)
		}
		if deployment.PLCID != "plc-1" || deployment.ConfigVersion != 7 || len(deployment.Mappings) != 5 {
			t.Fatalf("unexpected deployment %+v", deployment)
		}
		speed, ok := deployment.Mapping("m-speed")
		if !ok || !speed.Writable() || speed.Encoding().Scale != 0.1 {
			t.Fatalf("speed mapping %+v", speed)
		}
	}
}

// refusal parses a file whose document or body was changed, and returns the rule broken.
func refusal(t *testing.T, change func(document map[string]any, body map[string]any)) string {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(testkit.File("plc-1", "PLC-01", "127.0.0.1", 502, testkit.Options{}), &document); err != nil {
		t.Fatal(err)
	}
	body := document["deployment"].(map[string]any)
	change(document, body)
	raw, _ := json.Marshal(body)
	sum, _ := config.Checksum(raw)
	if _, keep := document["checksum"].(string); keep && !strings.HasPrefix(document["checksum"].(string), "keep:") {
		document["checksum"] = sum
	} else {
		document["checksum"] = strings.TrimPrefix(document["checksum"].(string), "keep:")
	}
	data, _ := json.Marshal(document)
	_, err := config.Parse(data)
	if err == nil {
		return "accepted"
	}
	return config.RuleOf(err)
}

func mapping(body map[string]any, index int) map[string]any {
	return body["mappings"].([]any)[index].(map[string]any)
}

func TestRefusesEveryBrokenRule(t *testing.T) {
	cases := map[string]func(document, body map[string]any){
		"schema":         func(d, _ map[string]any) { d["schema"] = "something.else" },
		"schema-version": func(d, _ map[string]any) { d["schemaVersion"] = 2 },
		"config-version": func(d, _ map[string]any) { d["configVersion"] = 0 },
		"plc-id":         func(_, b map[string]any) { b["plc"].(map[string]any)["plcId"] = "plc-2" },
		"protocol":       func(_, b map[string]any) { b["connection"].(map[string]any)["protocol"] = "S7" },
		"host":           func(_, b map[string]any) { b["connection"].(map[string]any)["host"] = "bad host;rm" },
		"port":           func(_, b map[string]any) { b["connection"].(map[string]any)["port"] = 70000 },
		"poll-interval":  func(_, b map[string]any) { b["connection"].(map[string]any)["pollIntervalMs"] = 10 },
		"mapping-id":     func(_, b map[string]any) { mapping(b, 1)["id"] = "m-start" },
		"mapping-name":   func(_, b map[string]any) { mapping(b, 1)["name"] = "Start_Cmd" },
		"mapping-type":   func(_, b map[string]any) { mapping(b, 3)["dataType"] = "STRING" },
		"mapping-area":   func(_, b map[string]any) { mapping(b, 3)["area"] = "COIL" },
		"mapping-width":  func(_, b map[string]any) { mapping(b, 4)["wordCount"] = 1 },
		"mapping-address": func(_, b map[string]any) {
			mapping(b, 4)["address"] = 65535
		},
		"mapping-scale": func(_, b map[string]any) { mapping(b, 3)["scale"] = 0 },
		// The cloud may write command and setpoint memory only: never feedback or an output.
		"mapping-write": func(_, b map[string]any) { mapping(b, 3)["access"] = "WRITE" },
		"mapping-range": func(_, b map[string]any) { delete(mapping(b, 1), "max") },
		"mapping-access": func(_, b map[string]any) {
			mapping(b, 3)["access"] = "READ_WRITE"
		},
		"json": func(_, b map[string]any) { b["surprise"] = true },
	}
	for want, change := range cases {
		if got := refusal(t, change); got != want {
			t.Errorf("%s: got %s", want, got)
		}
	}
	// A writable input area cannot be written over Modbus even when it is a command.
	if got := refusal(t, func(_, b map[string]any) {
		m := mapping(b, 1)
		m["area"] = "INPUT_REGISTER"
	}); got != "mapping-write" {
		t.Errorf("input register command: got %s", got)
	}
}

func TestRefusesAFileThatWasChangedOrCutShort(t *testing.T) {
	if _, err := config.Parse(testkit.File("plc-1", "PLC-01", "127.0.0.1", 502, testkit.Options{Corrupt: true})); config.RuleOf(err) != "checksum" {
		t.Fatalf("changed body: %v", err)
	}
	data := testkit.File("plc-1", "PLC-01", "127.0.0.1", 502, testkit.Options{})
	if _, err := config.Parse(data[:len(data)/2]); config.RuleOf(err) != "json" {
		t.Fatalf("cut short: %v", err)
	}
	if _, err := config.Parse(append(bytes.Clone(data), []byte(`{"again":1}`)...)); config.RuleOf(err) != "json" {
		t.Fatalf("trailing data: %v", err)
	}
	if _, err := config.Parse(make([]byte, config.MaxFileBytes+1)); config.RuleOf(err) != "file-size" {
		t.Fatalf("too large: %v", err)
	}
}
