package command_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/command"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/testkit"
)

var now = time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)

func deployment(t *testing.T) *config.Deployment {
	t.Helper()
	d, err := config.Parse(testkit.File("plc-1", "PLC-01", "127.0.0.1", 502, testkit.Options{Version: 4}))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func message(change func(map[string]any)) []byte {
	envelope := map[string]any{
		"schema": "zfactory.command", "version": 1, "commandId": "cmd-1", "plcId": "plc-1", "mappingId": "m-speed",
		"value": 42.5, "configVersion": 4, "issuedAt": now.Format(time.RFC3339), "expiresAt": now.Add(30 * time.Second).Format(time.RFC3339),
	}
	if change != nil {
		change(envelope)
	}
	data, _ := json.Marshal(envelope)
	return data
}

func check(t *testing.T, data []byte, topicPLC string) (command.Write, string) {
	t.Helper()
	envelope, refusal := command.Parse(data)
	if refusal != nil {
		return command.Write{}, refusal.Rule
	}
	write, refusal := command.Check(envelope, topicPLC, deployment(t), now)
	if refusal != nil {
		return command.Write{}, refusal.Rule
	}
	return write, ""
}

func TestAcceptsACommandToACommandOrSetpointTag(t *testing.T) {
	write, rule := check(t, message(nil), "plc-1")
	if rule != "" || write.Mapping.Name != "Speed_SP" || len(write.Words) != 1 || write.Words[0] != 425 {
		t.Fatalf("speed: %+v %s", write, rule)
	}
	// The cloud's absolute deadline travels with the write, unchanged (TASK-907).
	if !write.ExpiresAt.Equal(now.Add(30 * time.Second).Truncate(time.Second)) {
		t.Fatalf("deadline %v, want %v", write.ExpiresAt, now.Add(30*time.Second))
	}
	write, rule = check(t, message(func(e map[string]any) { e["mappingId"], e["value"] = "m-start", true }), "plc-1")
	if rule != "" || !write.Bool || write.Mapping.Area != "COIL" {
		t.Fatalf("start: %+v %s", write, rule)
	}
}

func TestRefusesEverythingElse(t *testing.T) {
	cases := map[string]struct {
		change func(map[string]any)
		topic  string
	}{
		"command-json":         {func(e map[string]any) { e["extra"] = 1 }, "plc-1"},
		"command-schema":       {func(e map[string]any) { e["version"] = 2 }, "plc-1"},
		"command-id":           {func(e map[string]any) { e["commandId"] = "has space" }, "plc-1"},
		"command-plc":          {nil, "plc-2"},
		"stale-config-version": {func(e map[string]any) { e["configVersion"] = 3 }, "plc-1"},
		"command-expired":      {func(e map[string]any) { e["expiresAt"] = now.Add(-time.Second).Format(time.RFC3339) }, "plc-1"},
		"command-expiry":       {func(e map[string]any) { e["expiresAt"] = now.Add(time.Hour).Format(time.RFC3339) }, "plc-1"},
		"unknown-mapping":      {func(e map[string]any) { e["mappingId"] = "m-nothing" }, "plc-1"},
		// What the program drives or the field feeds back is never written from the cloud.
		"not-writable": {func(e map[string]any) { e["mappingId"], e["value"] = "m-running", true }, "plc-1"},
		"value-type":   {func(e map[string]any) { e["value"] = "fast" }, "plc-1"},
		"value-range":  {func(e map[string]any) { e["value"] = 5000 }, "plc-1"},
	}
	for want, c := range cases {
		if _, got := check(t, message(c.change), c.topic); got != want {
			t.Errorf("%s: got %q", want, got)
		}
	}
	if _, got := check(t, message(func(e map[string]any) { e["mappingId"], e["value"] = "m-start", 1 }), "plc-1"); got != "value-type" {
		t.Errorf("a number for a BOOL: %q", got)
	}
	envelope, _ := command.Parse(message(nil))
	if _, refusal := command.Check(envelope, "plc-1", nil, now); refusal == nil || refusal.Rule != "unknown-plc" {
		t.Errorf("unknown PLC: %v", refusal)
	}
	// A broken message still names its command when it can, so the refusal can be answered.
	envelope, refusal := command.Parse([]byte(`{"commandId":"cmd-9","schema":"zfactory.command","oops":true}`))
	if refusal == nil || envelope.CommandID != "cmd-9" {
		t.Errorf("broken message: %+v %v", envelope, refusal)
	}
}

func TestRemembersCommandsSoNoneIsWrittenTwice(t *testing.T) {
	cache := command.NewCache(2, time.Minute)
	first := command.Ack{CommandID: "a", PLCID: "plc-1", Status: command.Accepted}
	if _, isNew := cache.Claim(first, now); !isNew {
		t.Fatal("a new command is new")
	}
	cache.Update(command.Ack{CommandID: "a", PLCID: "plc-1", Status: command.Applied})
	if previous, isNew := cache.Claim(first, now); isNew || previous.Status != command.Applied {
		t.Fatalf("a repeated command gets the last answer: %+v", previous)
	}
	// The same id for another PLC is another command.
	if _, isNew := cache.Claim(command.Ack{CommandID: "a", PLCID: "plc-2"}, now); !isNew {
		t.Fatal("other PLC")
	}
	cache.Forget("plc-2", "a")
	if _, isNew := cache.Claim(command.Ack{CommandID: "a", PLCID: "plc-2"}, now); !isNew {
		t.Fatal("a forgotten command can be sent again")
	}
	// Bounded and expiring.
	cache.Claim(command.Ack{CommandID: "b", PLCID: "plc-1"}, now)
	if cache.Len() != 2 {
		t.Fatalf("bounded: %d", cache.Len())
	}
	if _, isNew := cache.Claim(command.Ack{CommandID: "c", PLCID: "plc-1"}, now.Add(2*time.Minute)); !isNew || cache.Len() != 1 {
		t.Fatalf("expired: %d", cache.Len())
	}
}
