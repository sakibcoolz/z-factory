// Package health serves the agent's state on a local HTTP endpoint (127.0.0.1 by default):
//
//	GET /healthz          liveness: "ok", or "degraded" when a PLC is not online
//	GET /v1/status        the agent, its files and every PLC worker
//	GET /v1/plcs/{plcId}  one PLC worker with its current values
//	GET /metrics          the same numbers in the Prometheus text format
//
// It only reads; nothing on it changes what the agent does. It carries no secret.
package health

import (
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/deploy"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/supervisor"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/telemetry"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/worker"
)

// Source is where the server reads the agent's state.
type Source struct {
	Version    string
	StartedAt  time.Time
	Store      *deploy.Store
	Supervisor *supervisor.Supervisor
	Queue      *telemetry.Queue
	// Uplink describes where telemetry goes; nil until an uplink is configured.
	Uplink func() map[string]any
}

// AgentStatus is the body of /v1/status.
type AgentStatus struct {
	Agent struct {
		Version   string         `json:"version"`
		StartedAt time.Time      `json:"startedAt"`
		UptimeS   int64          `json:"uptimeS"`
		Status    string         `json:"status"`
		Workers   int            `json:"workers"`
		ByState   map[string]int `json:"byState"`
		Started   uint64         `json:"workersStarted"`
		Stopped   uint64         `json:"workersStopped"`
	} `json:"agent"`
	Files  deploy.Report       `json:"files"`
	Queue  telemetry.Stats     `json:"queue"`
	Uplink map[string]any      `json:"uplink"`
	PLCs   []supervisor.Status `json:"plcs"`
}

// Status builds the agent's status now.
func (s Source) Status() AgentStatus {
	var status AgentStatus
	plcs := s.Supervisor.Statuses()
	running, started, stopped := s.Supervisor.Counts()
	status.Agent.Version = s.Version
	status.Agent.StartedAt = s.StartedAt.UTC()
	status.Agent.UptimeS = int64(time.Since(s.StartedAt).Seconds())
	status.Agent.Workers = running
	status.Agent.Started = started
	status.Agent.Stopped = stopped
	status.Agent.ByState = map[string]int{}
	status.Agent.Status = "ok"
	for _, plc := range plcs {
		status.Agent.ByState[plc.State]++
		if plc.State != worker.Online {
			status.Agent.Status = "degraded"
		}
	}
	status.Files = s.Store.Report()
	if len(status.Files.Problems) > 0 {
		status.Agent.Status = "degraded"
	}
	status.Queue = s.Queue.Stats()
	if s.Uplink != nil {
		status.Uplink = s.Uplink()
	} else {
		status.Uplink = map[string]any{"configured": false}
	}
	status.PLCs = plcs
	return status
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(body)
}

// Handler serves the endpoints.
func Handler(source Source) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		status := source.Status()
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  status.Agent.Status,
			"version": status.Agent.Version,
			"uptimeS": status.Agent.UptimeS,
			"workers": status.Agent.Workers,
		})
	})
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, source.Status())
	})
	mux.HandleFunc("GET /v1/plcs/{plcId}", func(w http.ResponseWriter, r *http.Request) {
		status, ok := source.Supervisor.Status(r.PathValue("plcId"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no worker for this PLC"})
			return
		}
		writeJSON(w, http.StatusOK, status)
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(metrics(source.Status())))
	})
	return mux
}

func label(value string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(value)
}

func metrics(status AgentStatus) string {
	var b strings.Builder
	line := func(name, help, kind string) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, kind)
	}
	line("zfactory_agent_uptime_seconds", "Seconds since the agent started.", "gauge")
	fmt.Fprintf(&b, "zfactory_agent_uptime_seconds{version=\"%s\"} %d\n", label(status.Agent.Version), status.Agent.UptimeS)
	line("zfactory_agent_active_configs", "Deployments in force.", "gauge")
	fmt.Fprintf(&b, "zfactory_agent_active_configs %d\n", status.Files.Active)
	line("zfactory_agent_rejected_configs", "Deployment files refused since start (recent ones are listed in /v1/status).", "gauge")
	fmt.Fprintf(&b, "zfactory_agent_rejected_configs %d\n", len(status.Files.Rejections))
	line("zfactory_agent_workers", "PLC workers by state.", "gauge")
	states := make([]string, 0, len(status.Agent.ByState))
	for state := range status.Agent.ByState {
		states = append(states, state)
	}
	sort.Strings(states)
	for _, state := range states {
		fmt.Fprintf(&b, "zfactory_agent_workers{state=\"%s\"} %d\n", state, status.Agent.ByState[state])
	}
	line("zfactory_agent_queue_depth", "Telemetry batches waiting for the uplink.", "gauge")
	fmt.Fprintf(&b, "zfactory_agent_queue_depth %d\n", status.Queue.Depth)
	line("zfactory_agent_queue_dropped_total", "Telemetry batches dropped because the queue was full.", "counter")
	fmt.Fprintf(&b, "zfactory_agent_queue_dropped_total %d\n", status.Queue.Dropped)
	if spooling, ok := status.Uplink["spool"].(map[string]any); ok && spooling["configured"] == true {
		line("zfactory_agent_spool_entries", "Telemetry batches kept while the cloud was away.", "gauge")
		fmt.Fprintf(&b, "zfactory_agent_spool_entries %v\n", spooling["entries"])
		line("zfactory_agent_spool_bytes", "Bytes of telemetry in the spool.", "gauge")
		fmt.Fprintf(&b, "zfactory_agent_spool_bytes %v\n", spooling["bytes"])
		line("zfactory_agent_spool_oldest_age_seconds", "Age of the oldest spooled batch; 0 when the spool is empty.", "gauge")
		age := 0.0
		if oldest, ok := spooling["oldest"].(*time.Time); ok && oldest != nil {
			age = time.Since(*oldest).Seconds()
		}
		fmt.Fprintf(&b, "zfactory_agent_spool_oldest_age_seconds %.0f\n", age)
		line("zfactory_agent_spool_dropped_total", "Spooled batches dropped by the size or age limit.", "counter")
		fmt.Fprintf(&b, "zfactory_agent_spool_dropped_total %v\n", spooling["dropped"])
	}
	if connected, ok := status.Uplink["connected"].(bool); ok {
		line("zfactory_agent_mqtt_connected", "1 while the MQTT broker connection is up.", "gauge")
		up := 0
		if connected {
			up = 1
		}
		fmt.Fprintf(&b, "zfactory_agent_mqtt_connected %d\n", up)
	}
	line("zfactory_agent_plc_up", "1 while the PLC worker is online.", "gauge")
	for _, plc := range status.PLCs {
		up := 0
		if plc.State == worker.Online {
			up = 1
		}
		fmt.Fprintf(&b, "zfactory_agent_plc_up{plc_id=\"%s\",plc=\"%s\"} %d\n", label(plc.PLCID), label(plc.Name), up)
	}
	line("zfactory_agent_plc_polls_total", "Polls of the PLC.", "counter")
	for _, plc := range status.PLCs {
		fmt.Fprintf(&b, "zfactory_agent_plc_polls_total{plc_id=\"%s\"} %d\n", label(plc.PLCID), plc.Polls)
	}
	line("zfactory_agent_plc_reconnects_total", "Times the worker connected again after losing the PLC.", "counter")
	for _, plc := range status.PLCs {
		fmt.Fprintf(&b, "zfactory_agent_plc_reconnects_total{plc_id=\"%s\"} %d\n", label(plc.PLCID), plc.Reconnects)
	}
	line("zfactory_agent_plc_poll_failures_total", "Polls or connection attempts of the PLC that failed.", "counter")
	for _, plc := range status.PLCs {
		fmt.Fprintf(&b, "zfactory_agent_plc_poll_failures_total{plc_id=\"%s\"} %d\n", label(plc.PLCID), plc.Failures)
	}
	line("zfactory_agent_plc_poll_duration_seconds", "How long the last complete poll of the PLC took.", "gauge")
	for _, plc := range status.PLCs {
		fmt.Fprintf(&b, "zfactory_agent_plc_poll_duration_seconds{plc_id=\"%s\"} %.6f\n", label(plc.PLCID), plc.LastPollMs/1000)
	}
	uplinkMetrics(&b, line, status.Uplink)
	processMetrics(&b, line)
	return b.String()
}

// uplinkMetrics adds the MQTT connection, command and spool counters (TASK-906).
func uplinkMetrics(b *strings.Builder, line func(name, help, kind string), uplink map[string]any) {
	if connects, ok := uplink["connects"].(uint64); ok {
		line("zfactory_agent_mqtt_connects_total", "Times the agent connected to the broker.", "counter")
		fmt.Fprintf(b, "zfactory_agent_mqtt_connects_total %d\n", connects)
	}
	if lost, ok := uplink["lostConnections"].(uint64); ok {
		line("zfactory_agent_mqtt_connections_lost_total", "Times the broker connection was lost.", "counter")
		fmt.Fprintf(b, "zfactory_agent_mqtt_connections_lost_total %d\n", lost)
	}
	if published, ok := uplink["published"].(uint64); ok {
		line("zfactory_agent_mqtt_published_total", "Telemetry batches the broker took live.", "counter")
		fmt.Fprintf(b, "zfactory_agent_mqtt_published_total %d\n", published)
	}
	if commands, ok := uplink["commands"].(map[string]uint64); ok {
		line("zfactory_agent_commands_total", "Cloud commands by outcome.", "counter")
		outcomes := make([]string, 0, len(commands))
		for outcome := range commands {
			outcomes = append(outcomes, outcome)
		}
		sort.Strings(outcomes)
		for _, outcome := range outcomes {
			fmt.Fprintf(b, "zfactory_agent_commands_total{outcome=\"%s\"} %d\n", label(outcome), commands[outcome])
		}
	}
	if spooling, ok := uplink["spool"].(map[string]any); ok && spooling["configured"] == true {
		line("zfactory_agent_spool_written_total", "Telemetry batches put in the spool.", "counter")
		fmt.Fprintf(b, "zfactory_agent_spool_written_total %v\n", spooling["written"])
		line("zfactory_agent_spool_replayed_total", "Spooled batches sent after a reconnect.", "counter")
		fmt.Fprintf(b, "zfactory_agent_spool_replayed_total %v\n", spooling["replayed"])
	}
}

// processMetrics adds the agent process's own resources: goroutines, memory and CPU time.
func processMetrics(b *strings.Builder, line func(name, help, kind string)) {
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	line("go_goroutines", "Goroutines of the agent.", "gauge")
	fmt.Fprintf(b, "go_goroutines %d\n", runtime.NumGoroutine())
	line("go_memstats_heap_alloc_bytes", "Heap bytes in use.", "gauge")
	fmt.Fprintf(b, "go_memstats_heap_alloc_bytes %d\n", memory.HeapAlloc)
	line("go_memstats_sys_bytes", "Bytes the Go runtime holds from the operating system.", "gauge")
	fmt.Fprintf(b, "go_memstats_sys_bytes %d\n", memory.Sys)
	line("go_gc_cycles_total", "Completed garbage collections.", "counter")
	fmt.Fprintf(b, "go_gc_cycles_total %d\n", memory.NumGC)
	var usage syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &usage) == nil {
		cpu := float64(usage.Utime.Sec+usage.Stime.Sec) + float64(usage.Utime.Usec+usage.Stime.Usec)/1e6
		line("process_cpu_seconds_total", "User and system CPU time of the agent.", "counter")
		fmt.Fprintf(b, "process_cpu_seconds_total %.3f\n", cpu)
		line("process_max_resident_memory_bytes", "Peak resident memory of the agent.", "gauge")
		fmt.Fprintf(b, "process_max_resident_memory_bytes %d\n", usage.Maxrss*1024)
	}
}
