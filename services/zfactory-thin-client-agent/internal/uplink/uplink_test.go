package uplink_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/agent"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/deploy"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/modbustest"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/testkit"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/uplink"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/worker"
)

func TestRefusesSettingsThatWouldLeakOrBreakTopics(t *testing.T) {
	cases := map[string]uplink.Settings{
		"missing":     {SiteID: "s", AgentID: "a"},
		"credentials": {BrokerURL: "tcp://user:secret@broker:1883", SiteID: "s", AgentID: "a"},
		"scheme":      {BrokerURL: "http://broker:1883", SiteID: "s", AgentID: "a"},
		"wildcard":    {BrokerURL: "tcp://broker:1883", SiteID: "site/#", AgentID: "a"},
	}
	for name, settings := range cases {
		_, err := uplink.Start(context.Background(), settings, nil, nil, nil, nil)
		if err == nil {
			t.Errorf("%s: accepted", name)
		} else if strings.Contains(err.Error(), "secret") {
			t.Errorf("%s: the error repeats the password: %v", name, err)
		}
	}
}

// broker runs an eclipse-mosquitto container for the test (ZFACTORY_AGENT_DOCKER=1).
type broker struct {
	name string
	url  string
}

func startBroker(t *testing.T) *broker {
	t.Helper()
	if os.Getenv("ZFACTORY_AGENT_DOCKER") != "1" {
		t.Skip("set ZFACTORY_AGENT_DOCKER=1 to run against an eclipse-mosquitto container")
	}
	name := fmt.Sprintf("zfactory-agent-test-mqtt-%d", time.Now().UnixNano())
	out, err := exec.Command("docker", "run", "-d", "--rm", "--name", name, "--label", "zfactory.test-run=agent",
		"-p", "127.0.0.1::1883", "eclipse-mosquitto:2", "mosquitto", "-c", "/mosquitto-no-auth.conf").CombinedOutput()
	if err != nil {
		t.Fatalf("docker run: %v %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	port, err := exec.Command("docker", "port", name, "1883/tcp").Output()
	if err != nil {
		t.Fatalf("docker port: %v", err)
	}
	address := strings.TrimSpace(strings.Split(string(port), "\n")[0])
	return &broker{name: name, url: "tcp://" + address}
}

func (b *broker) restart(t *testing.T, down time.Duration) {
	t.Helper()
	b.stop(t)
	time.Sleep(down)
	b.start(t)
}

// stop takes the broker away; its container is removed (it runs with --rm).
func (b *broker) stop(t *testing.T) {
	t.Helper()
	if out, err := exec.Command("docker", "stop", "-t", "0", b.name).CombinedOutput(); err != nil && !strings.Contains(string(out), "No such") {
		t.Logf("docker stop: %v %s", err, out)
	}
	_ = out(exec.Command("docker", "wait", b.name))
}

// start brings a broker back on the same address.
func (b *broker) start(t *testing.T) {
	t.Helper()
	host := strings.TrimPrefix(b.url, "tcp://")
	if out, err := exec.Command("docker", "run", "-d", "--rm", "--name", b.name, "--label", "zfactory.test-run=agent",
		"-p", host+":1883", "eclipse-mosquitto:2", "mosquitto", "-c", "/mosquitto-no-auth.conf").CombinedOutput(); err != nil {
		t.Fatalf("docker run again: %v %s", err, out)
	}
}

func out(command *exec.Cmd) error { return command.Run() }

// cloud is the test's MQTT client, standing where Web Factory will.
type cloud struct {
	client   mqtt.Client
	mu       sync.Mutex
	messages map[string][]map[string]any
}

func connectCloud(t *testing.T, url string) *cloud {
	t.Helper()
	c := &cloud{messages: map[string][]map[string]any{}}
	options := mqtt.NewClientOptions().AddBroker(url).SetClientID(fmt.Sprintf("cloud-%d", time.Now().UnixNano())).
		SetAutoReconnect(true).SetConnectRetry(true).SetConnectRetryInterval(200 * time.Millisecond).
		SetOnConnectHandler(func(client mqtt.Client) {
			client.Subscribe("zfactory/#", 1, func(_ mqtt.Client, message mqtt.Message) {
				var body map[string]any
				if len(message.Payload()) > 0 {
					_ = json.Unmarshal(message.Payload(), &body)
				}
				c.mu.Lock()
				c.messages[message.Topic()] = append(c.messages[message.Topic()], body)
				c.mu.Unlock()
			}).Wait()
		})
	c.client = mqtt.NewClient(options)
	c.client.Connect().Wait()
	t.Cleanup(func() { c.client.Disconnect(100) })
	return c
}

func (c *cloud) on(topic string) []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]map[string]any(nil), c.messages[topic]...)
}

func (c *cloud) acks(topic, commandID string) []string {
	var statuses []string
	for _, ack := range c.on(topic) {
		if ack["commandId"] == commandID {
			status := ack["status"].(string)
			if rule, ok := ack["rule"].(string); ok {
				status += ":" + rule
			}
			if ack["duplicate"] == true {
				status += ":duplicate"
			}
			statuses = append(statuses, status)
		}
	}
	return statuses
}

func (c *cloud) send(t *testing.T, topic string, envelope map[string]any) {
	t.Helper()
	payload, _ := json.Marshal(envelope)
	if token := c.client.Publish(topic, 1, false, payload); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("publish: %v", token.Error())
	}
}

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func stage(t *testing.T, dir, name string, data []byte) {
	t.Helper()
	temporary := filepath.Join(dir, deploy.Staging, "."+name+".tmp")
	if err := os.WriteFile(temporary, data, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, filepath.Join(dir, deploy.Staging, name)); err != nil {
		t.Fatal(err)
	}
}

func TestCarriesTelemetryUpAndCheckedCommandsDown(t *testing.T) {
	b := startBroker(t)
	plcA, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer plcA.Close()
	plcB, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer plcB.Close()
	plcA.SetHolding(1024, 300)
	plcB.SetHolding(1024, 450)

	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, deploy.Staging), 0o750); err != nil {
		t.Fatal(err)
	}
	for id, server := range map[string]*modbustest.Server{"plc-a": plcA, "plc-b": plcB} {
		host, port := server.Addr()
		stage(t, dir, id+".json", testkit.File(id, strings.ToUpper(id), host, port, testkit.Options{Version: 3, PollMs: 200}))
	}
	cloud := connectCloud(t, b.url)
	a, err := agent.Start(context.Background(), agent.Settings{
		Dir: dir, HealthAddr: "127.0.0.1:0", ScanInterval: 100 * time.Millisecond, Version: "test",
		Uplink: &uplink.Settings{BrokerURL: b.url, SiteID: "site-1", AgentID: "edge-1", Publishers: 2, Heartbeat: 300 * time.Millisecond},
	})
	if err != nil {
		t.Fatal(err)
	}
	root := "zfactory/site-1/edge-1"

	// Up: both PLCs' telemetry through the shared publishers, their state, the heartbeat, online.
	eventually(t, "telemetry of both PLCs", func() bool {
		return len(cloud.on(root+"/telemetry/plc-a")) > 2 && len(cloud.on(root+"/telemetry/plc-b")) > 2
	})
	last := cloud.on(root + "/telemetry/plc-b")
	batch := last[len(last)-1]
	if batch["schema"] != "zfactory.telemetry" || batch["plcId"] != "plc-b" || batch["configVersion"] != 3.0 {
		t.Fatalf("telemetry %v", batch)
	}
	actual := false
	for _, v := range batch["values"].([]any) {
		value := v.(map[string]any)
		if value["name"] == "Actual_Hz" && value["value"] == 45.0 && value["quality"] == "GOOD" {
			actual = true
		}
	}
	if !actual {
		t.Fatalf("Actual_Hz missing from %v", batch["values"])
	}
	eventually(t, "state and heartbeat", func() bool {
		states := cloud.on(root + "/state/plc-a")
		return len(states) > 0 && states[len(states)-1]["state"] == worker.Online && len(cloud.on(root+"/agent/heartbeat")) > 0
	})
	if status := cloud.on(root + "/agent/status"); len(status) == 0 || status[len(status)-1]["status"] != "online" {
		t.Fatalf("agent status %v", status)
	}

	// Down: a setpoint to PLC A, accepted, written once, applied and read back.
	command := func(id, mapping string, value any, change func(map[string]any)) map[string]any {
		envelope := map[string]any{
			"schema": "zfactory.command", "version": 1, "commandId": id, "plcId": "plc-a", "mappingId": mapping, "value": value,
			"configVersion": 3, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano),
			"expiresAt": time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339Nano), "requestedBy": "operator-1",
		}
		if change != nil {
			change(envelope)
		}
		return envelope
	}
	cloud.send(t, root+"/command/plc-a", command("cmd-1", "m-speed", 42.5, nil))
	eventually(t, "the setpoint applied", func() bool { return len(cloud.acks(root+"/ack/plc-a", "cmd-1")) == 2 })
	if got := cloud.acks(root+"/ack/plc-a", "cmd-1"); strings.Join(got, ",") != "ACCEPTED,APPLIED" {
		t.Fatalf("acks %v", got)
	}
	if plcA.HoldingAt(100, 1)[0] != 425 {
		t.Fatalf("PLC A setpoint register: %v", plcA.HoldingAt(100, 1))
	}

	// Delivered twice: answered twice, written once.
	cloud.send(t, root+"/command/plc-a", command("cmd-1", "m-speed", 42.5, nil))
	eventually(t, "the duplicate answered", func() bool { return len(cloud.acks(root+"/ack/plc-a", "cmd-1")) == 3 })
	if got := cloud.acks(root+"/ack/plc-a", "cmd-1")[2]; got != "APPLIED:duplicate" {
		t.Fatalf("duplicate ack %s", got)
	}

	// Refused, each with its reason, and nothing written.
	refusals := map[string]map[string]any{
		"r-output":  command("r-output", "m-running", true, nil),
		"r-unknown": command("r-unknown", "m-nothing", 1, nil),
		"r-range":   command("r-range", "m-speed", 9999, nil),
		"r-type":    command("r-type", "m-start", 1, nil),
		"r-stale":   command("r-stale", "m-speed", 10, func(e map[string]any) { e["configVersion"] = 2 }),
		"r-expired": command("r-expired", "m-speed", 10, func(e map[string]any) { e["expiresAt"] = time.Now().Add(-time.Second).UTC().Format(time.RFC3339) }),
		"r-plc":     command("r-plc", "m-speed", 10, func(e map[string]any) { e["plcId"] = "plc-b" }),
	}
	for _, envelope := range refusals {
		cloud.send(t, root+"/command/plc-a", envelope)
	}
	cloud.send(t, root+"/command/plc-z", command("r-nowhere", "m-speed", 10, func(e map[string]any) { e["plcId"] = "plc-z" }))
	// JSON of the wrong shape is refused under its id; garbage is answered without one.
	cloud.client.Publish(root+"/command/plc-a", 1, false, []byte(`{"commandId":"r-json","schema":"zfactory.command","oops":1}`)).Wait()
	cloud.client.Publish(root+"/command/plc-a", 1, false, []byte(`{"commandId":"r-garbage","sch`)).Wait()
	want := map[string]string{
		"r-output": "REJECTED:not-writable", "r-unknown": "REJECTED:unknown-mapping", "r-range": "REJECTED:value-range",
		"r-type": "REJECTED:value-type", "r-stale": "REJECTED:stale-config-version", "r-expired": "REJECTED:command-expired",
		"r-plc": "REJECTED:command-plc", "r-json": "REJECTED:command-json",
	}
	for id, status := range want {
		eventually(t, id, func() bool { return len(cloud.acks(root+"/ack/plc-a", id)) == 1 })
		if got := cloud.acks(root+"/ack/plc-a", id)[0]; got != status {
			t.Errorf("%s: %s, want %s", id, got, status)
		}
	}
	eventually(t, "the garbage refused", func() bool { return len(cloud.acks(root+"/ack/plc-a", "")) == 1 })
	if got := cloud.acks(root+"/ack/plc-a", "")[0]; got != "REJECTED:command-json" {
		t.Errorf("garbage: %s", got)
	}
	eventually(t, "r-nowhere", func() bool { return len(cloud.acks(root+"/ack/plc-z", "r-nowhere")) == 1 })
	if got := cloud.acks(root+"/ack/plc-z", "r-nowhere")[0]; got != "REJECTED:unknown-plc" {
		t.Errorf("unknown PLC: %s", got)
	}
	if writes := plcA.Writes(); len(writes) != 1 {
		t.Fatalf("only the applied command was written to PLC A: %v", writes)
	}
	if writes := plcB.Writes(); len(writes) != 0 {
		t.Fatalf("PLC B was never written: %v", writes)
	}

	// The broker goes away: polling goes on, and everything resumes when it is back.
	polls := func(id string) uint64 {
		status, _ := a.Supervisor().Status(id)
		return status.Polls
	}
	before := polls("plc-a")
	b.restart(t, time.Second)
	if polls("plc-a") <= before {
		t.Fatalf("polling stopped while the broker was away")
	}
	telemetryBefore := len(cloud.on(root + "/telemetry/plc-a"))
	eventually(t, "telemetry after the broker returned", func() bool {
		return len(cloud.on(root+"/telemetry/plc-a")) > telemetryBefore+2
	})
	// The command subscription survived the reconnect.
	cloud.send(t, root+"/command/plc-a", command("cmd-2", "m-start", true, nil))
	eventually(t, "a command after the reconnect", func() bool {
		got := cloud.acks(root+"/ack/plc-a", "cmd-2")
		return len(got) == 2 && got[1] == "APPLIED"
	})
	if !plcA.CoilAt(800) {
		t.Fatal("start coil not set")
	}
	status := a.Status().Uplink
	if status["connected"] != true || status["lostConnections"].(uint64) < 1 {
		t.Fatalf("uplink status %v", status)
	}
	counts := status["commands"].(map[string]uint64)
	if counts["applied"] != 2 || counts["duplicates"] != 1 || counts["rejected"] != 10 {
		t.Fatalf("command counts %v", counts)
	}

	// A PLC that is removed leaves no retained state; stopping says offline.
	if err := os.Remove(filepath.Join(dir, deploy.Active, "plc-b.json")); err != nil {
		t.Fatal(err)
	}
	eventually(t, "plc-b state cleared", func() bool {
		states := cloud.on(root + "/state/plc-b")
		return len(states) > 0 && states[len(states)-1] == nil
	})
	if err := a.Stop(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "offline", func() bool {
		status := cloud.on(root + "/agent/status")
		return len(status) > 0 && status[len(status)-1]["status"] == "offline"
	})
}

func spooled(a *agent.Agent) int {
	status, _ := a.Status().Uplink["spool"].(map[string]any)
	entries, _ := status["entries"].(int)
	return entries
}

func TestSpoolsWhileTheBrokerIsAwayAndReplaysAfter(t *testing.T) {
	b := startBroker(t)
	plc, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer plc.Close()
	plc.SetHolding(1024, 300)
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, deploy.Staging), 0o750); err != nil {
		t.Fatal(err)
	}
	host, port := plc.Addr()
	stage(t, dir, "plc-a.json", testkit.File("plc-a", "PLC-A", host, port, testkit.Options{PollMs: 100}))
	settings := agent.Settings{
		Dir: dir, HealthAddr: "127.0.0.1:0", ScanInterval: 100 * time.Millisecond, Version: "test",
		Uplink: &uplink.Settings{BrokerURL: b.url, SiteID: "site-1", AgentID: "edge-1", Publishers: 2, Heartbeat: 300 * time.Millisecond, ReplayRate: 20},
	}
	cloud := connectCloud(t, b.url)
	topic := "zfactory/site-1/edge-1/telemetry/plc-a"
	a, err := agent.Start(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "live telemetry", func() bool { return len(cloud.on(topic)) > 3 })
	if spooled(a) != 0 {
		t.Fatalf("nothing is spooled while the broker is there: %d", spooled(a))
	}

	// The broker goes away: polling goes on, and the batches are kept on disk.
	b.stop(t)
	eventually(t, "the spool to fill", func() bool { return spooled(a) >= 10 })

	// The agent restarts while the cloud is still away: the backlog survives it.
	if err := a.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, deploy.Spool, "telemetry.db")); err != nil {
		t.Fatalf("the spool file: %v", err)
	}
	a, err = agent.Start(context.Background(), settings)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = a.Stop() }()
	if after := spooled(a); after < 10 {
		t.Fatalf("the backlog was lost over the restart: %d", after)
	}
	eventually(t, "more spooled after the restart", func() bool { return spooled(a) >= 20 })
	backlog := spooled(a)
	returned := time.Now()

	// The broker returns: the backlog is replayed at its rate, oldest first, while live
	// telemetry keeps flowing beside it.
	b.start(t)
	eventually(t, "the spool to drain", func() bool { return spooled(a) == 0 })
	var replayed, liveDuring int
	lastReplay := -1
	messages := cloud.on(topic)
	for index, message := range messages {
		if message["replayed"] == true {
			replayed++
			lastReplay = index
		}
	}
	var previous time.Time
	for index, message := range messages {
		if message["replayed"] == true {
			// Batches spooled until the agent was connected again are replayed too, in order.
			at, _ := time.Parse(time.RFC3339Nano, message["at"].(string))
			if at.Before(previous) {
				t.Fatalf("replayed out of order: %v after %v", at, previous)
			}
			previous = at
		} else if index < lastReplay {
			at, _ := time.Parse(time.RFC3339Nano, message["at"].(string))
			if at.After(returned) {
				liveDuring++
			}
		}
	}
	if replayed < backlog {
		t.Fatalf("%d replayed of a backlog of %d", replayed, backlog)
	}
	if liveDuring == 0 {
		t.Fatal("live telemetry waited for the replay")
	}
	response, err := http.Get("http://" + a.HealthAddr() + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	metrics, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	for _, want := range []string{
		"zfactory_agent_spool_entries 0",
		"zfactory_agent_mqtt_connected 1",
		"zfactory_agent_spool_bytes 0",
		"zfactory_agent_mqtt_connects_total ",
		"zfactory_agent_mqtt_connections_lost_total ",
		"zfactory_agent_spool_written_total ",
		"zfactory_agent_spool_replayed_total ",
		`zfactory_agent_commands_total{outcome="accepted"}`,
	} {
		if !strings.Contains(string(metrics), want) {
			t.Errorf("metrics lack %q:\n%s", want, metrics)
		}
	}
	status := a.Status().Uplink["spool"].(map[string]any)
	t.Logf("backlog %d, replayed %d, live during replay %d, spool %v", backlog, replayed, liveDuring, status)
}
