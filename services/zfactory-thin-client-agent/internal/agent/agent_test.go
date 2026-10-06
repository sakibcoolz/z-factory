package agent_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/agent"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/deploy"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/modbustest"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/testkit"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/worker"
)

func start(t *testing.T, dir string) *agent.Agent {
	t.Helper()
	a, err := agent.Start(context.Background(), agent.Settings{
		Dir: dir, HealthAddr: "127.0.0.1:0", ScanInterval: 50 * time.Millisecond, Settle: 0,
		BackoffMin: 20 * time.Millisecond, BackoffMax: 100 * time.Millisecond, Version: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	return a
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

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func get(t *testing.T, a *agent.Agent, path string, target any) int {
	t.Helper()
	response, err := http.Get("http://" + a.HealthAddr() + path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if target != nil {
		if err := json.NewDecoder(response.Body).Decode(target); err != nil {
			t.Fatal(err)
		}
	}
	return response.StatusCode
}

func online(a *agent.Agent) int { return a.Status().Agent.ByState[worker.Online] }

func TestRunsWhateverIsDeployedAndReloadsWithoutRestart(t *testing.T) {
	baseline := runtime.NumGoroutine()
	dir := t.TempDir()
	a := start(t, dir)

	// No deployment: healthy, no worker.
	var healthz map[string]any
	if code := get(t, a, "/healthz", &healthz); code != 200 || healthz["status"] != "ok" || healthz["workers"] != 0.0 {
		t.Fatalf("empty agent: %d %v", code, healthz)
	}

	plcs := make([]*modbustest.Server, 3)
	for i := range plcs {
		server, err := modbustest.Start()
		if err != nil {
			t.Fatal(err)
		}
		defer server.Close()
		server.SetHolding(1024, uint16(100*(i+1)))
		plcs[i] = server
		host, port := server.Addr()
		stage(t, dir, fmt.Sprintf("plc-%d.json", i), testkit.File(fmt.Sprintf("plc-%d", i), fmt.Sprintf("PLC-%02d", i), host, port, testkit.Options{}))
	}
	eventually(t, "three workers online", func() bool { return online(a) == 3 })

	var one map[string]any
	if code := get(t, a, "/v1/plcs/plc-1", &one); code != 200 {
		t.Fatalf("plc-1: %d", code)
	}
	values := one["values"].([]any)
	found := false
	for _, v := range values {
		entry := v.(map[string]any)
		if entry["name"] == "Actual_Hz" && entry["value"] == 20.0 && entry["quality"] == "GOOD" {
			found = true
		}
	}
	if !found {
		t.Fatalf("plc-1 values: %v", values)
	}
	if code := get(t, a, "/v1/plcs/nobody", nil); code != 404 {
		t.Fatalf("unknown PLC: %d", code)
	}

	// One PLC goes away: only its worker suffers.
	plcs[2].Close()
	eventually(t, "plc-2 to show the loss", func() bool {
		for _, status := range a.Status().PLCs {
			if status.PLCID == "plc-2" {
				return status.State != worker.Online
			}
		}
		return false
	})
	if online(a) != 2 || a.Status().Agent.Status != "degraded" {
		t.Fatalf("two still online: %+v", a.Status().Agent)
	}
	polls := map[string]uint64{}
	for _, status := range a.Status().PLCs {
		polls[status.PLCID] = status.Polls
	}
	time.Sleep(300 * time.Millisecond)
	for _, status := range a.Status().PLCs {
		if status.PLCID != "plc-2" && status.Polls <= polls[status.PLCID] {
			t.Fatalf("%s stopped polling", status.PLCID)
		}
	}

	// Update one PLC: only it restarts. A broken file changes nothing. Remove one: only it stops.
	_, startedBefore, _ := a.Supervisor().Counts()
	host, port := plcs[0].Addr()
	stage(t, dir, "plc-0.json", testkit.File("plc-0", "PLC-00", host, port, testkit.Options{Version: 2}))
	stage(t, dir, "garbage.json", []byte("{not json"))
	eventually(t, "the update", func() bool {
		status, _ := a.Supervisor().Status("plc-0")
		return status.ConfigVersion == 2 && status.State == worker.Online
	})
	if _, started, stopped := a.Supervisor().Counts(); started != startedBefore+1 || stopped != 1 {
		t.Fatalf("one replaced: started %d stopped %d", started, stopped)
	}
	eventually(t, "the rejection", func() bool { return len(a.Status().Files.Rejections) == 1 })
	if err := os.Remove(filepath.Join(dir, deploy.Active, "plc-2.json")); err != nil {
		t.Fatal(err)
	}
	eventually(t, "plc-2 to stop", func() bool { return a.Status().Agent.Workers == 2 })
	if online(a) != 2 {
		t.Fatalf("the others keep running: %+v", a.Status().Agent)
	}

	response, err := http.Get("http://" + a.HealthAddr() + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body := make([]byte, 1<<16)
	n, _ := response.Body.Read(body)
	_ = response.Body.Close()
	if !strings.Contains(string(body[:n]), `zfactory_agent_workers{state="ONLINE"} 2`) {
		t.Fatalf("metrics:\n%s", body[:n])
	}

	// Stopping leaves nothing running.
	if err := a.Stop(); err != nil {
		t.Fatal(err)
	}
	http.DefaultClient.CloseIdleConnections()
	for _, server := range plcs {
		server.Close()
	}
	eventually(t, "every goroutine to end", func() bool { return runtime.NumGoroutine() <= baseline+2 })
}

// TestManyPLCsStayBounded runs N PLC workers (ZFACTORY_AGENT_LOAD_N, default 200) against
// a few fake PLCs and checks that goroutines, queue and memory stay bounded.
func TestManyPLCsStayBounded(t *testing.T) {
	n := 200
	if value, err := strconv.Atoi(os.Getenv("ZFACTORY_AGENT_LOAD_N")); err == nil && value > 0 {
		n = value
	}
	servers := make([]*modbustest.Server, 4)
	for i := range servers {
		server, err := modbustest.Start()
		if err != nil {
			t.Fatal(err)
		}
		defer server.Close()
		servers[i] = server
	}
	dir := t.TempDir()
	for i := range n {
		host, port := servers[i%len(servers)].Addr()
		id := fmt.Sprintf("plc-%04d", i)
		if err := os.MkdirAll(filepath.Join(dir, deploy.Staging), 0o750); err != nil {
			t.Fatal(err)
		}
		stage(t, dir, id+".json", testkit.File(id, id, host, port, testkit.Options{PollMs: 200}))
	}
	baseline := runtime.NumGoroutine()
	a, err := agent.Start(context.Background(), agent.Settings{
		Dir: dir, HealthAddr: "127.0.0.1:0", ScanInterval: 100 * time.Millisecond, QueueCapacity: 500, MaxConcurrentPolls: 16,
	})
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, fmt.Sprintf("%d workers online", n), func() bool { return online(a) == n })
	time.Sleep(time.Second)
	status := a.Status()
	// One goroutine per worker in the agent, one per connection in the fake PLCs, and a
	// fixed few: nothing grows with polls.
	if goroutines := runtime.NumGoroutine() - baseline; goroutines > 2*n+20 {
		t.Fatalf("%d goroutines for %d PLCs", goroutines, n)
	}
	if status.Queue.Depth > status.Queue.Capacity {
		t.Fatalf("queue over capacity: %+v", status.Queue)
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	t.Logf("%d PLCs: %d goroutines, heap %d KiB, queue %+v", n, runtime.NumGoroutine(), memory.HeapAlloc/1024, status.Queue)
	if err := a.Stop(); err != nil {
		t.Fatal(err)
	}
}
