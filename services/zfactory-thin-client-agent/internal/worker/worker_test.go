package worker_test

import (
	"context"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/modbustest"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/telemetry"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/testkit"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/worker"
)

func deployment(t *testing.T, id string, server *modbustest.Server) *config.Deployment {
	t.Helper()
	host, port := server.Addr()
	parsed, err := config.Parse(testkit.File(id, id, host, port, testkit.Options{}))
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

type sink struct {
	mu      sync.Mutex
	batches []telemetry.Batch
}

func (s *sink) push(batch telemetry.Batch) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.batches = append(s.batches, batch)
}

func (s *sink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.batches)
}

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func value(snapshot worker.Snapshot, name string) telemetry.Value {
	for _, v := range snapshot.Values {
		if v.Name == name {
			return v
		}
	}
	return telemetry.Value{}
}

func TestReadsTheExportedMappingsTypedAndInFewRequests(t *testing.T) {
	server, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.SetCoil(8192, true)
	server.SetHolding(1024, 425)
	server.SetHolding(2048, 0x4020, 0x0000)

	received := &sink{}
	w := worker.New(deployment(t, "plc-1", server), worker.Options{Sink: received.push})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	eventually(t, "a poll", func() bool { return received.count() >= 2 })

	snapshot := w.Snapshot(true)
	if snapshot.State != worker.Online || snapshot.Writable != 2 {
		t.Fatalf("snapshot %+v", snapshot)
	}
	if got := value(snapshot, "Running"); got.Value != true || got.Quality != telemetry.Good {
		t.Errorf("Running %+v", got)
	}
	if got := value(snapshot, "Actual_Hz"); math.Abs(got.Value.(float64)-42.5) > 1e-9 {
		t.Errorf("Actual_Hz %+v", got)
	}
	if got := value(snapshot, "Pressure"); got.Value != 2.5 {
		t.Errorf("Pressure %+v", got)
	}
	// Only what the deployment names is read: never a scan of the address space.
	requests := server.Requests()
	polls := snapshot.Polls
	if requests > int(polls)*4+4 {
		t.Errorf("%d requests for %d polls", requests, polls)
	}
	if len(server.Writes()) != 0 {
		t.Errorf("a worker only reads: %v", server.Writes())
	}
	cancel()
	<-done
	if got := w.Snapshot(true); got.State != worker.Stopping || value(got, "Running").Quality != telemetry.Disconnected {
		t.Errorf("after stop %+v", got)
	}
}

func TestMarksARefusedRangeBadAndKeepsTheRest(t *testing.T) {
	server, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.SetHolding(1024, 100)
	server.Refuse(0x01, true)

	received := &sink{}
	w := worker.New(deployment(t, "plc-1", server), worker.Options{Sink: received.push})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)
	eventually(t, "a poll", func() bool { return received.count() >= 1 })
	snapshot := w.Snapshot(true)
	if snapshot.State != worker.Degraded {
		t.Fatalf("state %s", snapshot.State)
	}
	if value(snapshot, "Running").Quality != telemetry.Bad || value(snapshot, "Actual_Hz").Quality != telemetry.Good {
		t.Fatalf("values %+v", snapshot.Values)
	}
	server.Refuse(0x01, false)
	eventually(t, "online again", func() bool { return w.Snapshot(false).State == worker.Online })
}

func TestReconnectsWithBackoffAfterThePLCWentAway(t *testing.T) {
	server, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	host, port := server.Addr()
	received := &sink{}
	d := deployment(t, "plc-1", server)
	w := worker.New(d, worker.Options{Sink: received.push, BackoffMin: 20 * time.Millisecond, BackoffMax: 50 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)
	eventually(t, "online", func() bool { return w.Snapshot(false).State == worker.Online })

	server.Close()
	eventually(t, "the loss to show", func() bool {
		s := w.Snapshot(true)
		return (s.State == worker.Reconnecting || s.State == worker.Disconnected) && value(s, "Running").Quality == telemetry.Disconnected
	})
	if w.Snapshot(false).LastError == "" {
		t.Fatal("the error is reported")
	}

	// The PLC comes back on the same address.
	again, err := modbustest.StartAt(host, port)
	if err != nil {
		t.Skipf("port %d not free again: %v", port, err)
	}
	defer again.Close()
	eventually(t, "back online", func() bool { return w.Snapshot(false).State == worker.Online })
	if w.Snapshot(false).Reconnects < 1 {
		t.Fatal("the reconnect is counted")
	}
}

func TestASlowPLCDelaysOnlyItsOwnWorker(t *testing.T) {
	slow, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer slow.Close()
	fast, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer fast.Close()
	slow.SetDelay(400 * time.Millisecond)

	slowSink, fastSink := &sink{}, &sink{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go worker.New(deployment(t, "slow", slow), worker.Options{Sink: slowSink.push}).Run(ctx)
	go worker.New(deployment(t, "fast", fast), worker.Options{Sink: fastSink.push}).Run(ctx)
	time.Sleep(time.Second)
	if fastSink.count() < 5 {
		t.Fatalf("the fast PLC was held up: %d polls", fastSink.count())
	}
	if slowSink.count() > fastSink.count()/2 {
		t.Fatalf("slow %d, fast %d", slowSink.count(), fastSink.count())
	}
}
