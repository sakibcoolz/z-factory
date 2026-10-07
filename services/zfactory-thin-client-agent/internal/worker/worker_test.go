package worker_test

import (
	"context"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/command"
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

func TestWritesACheckedCommandAndReadsItBack(t *testing.T) {
	server, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	d := deployment(t, "plc-1", server)
	w := worker.New(d, worker.Options{})
	speed, _ := d.Mapping("m-speed")
	start, _ := d.Mapping("m-start")

	results := make(chan worker.Result, 4)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	eventually(t, "online", func() bool { return w.Snapshot(false).State == worker.Online })

	if err := w.Submit(command.Write{CommandID: "a", Mapping: speed, Words: []uint16{425}, Value: 42.5, ExpiresAt: later()}, func(r worker.Result) { results <- r }); err != nil {
		t.Fatal(err)
	}
	if r := <-results; r.Status != command.Applied || r.Observed != 42.5 {
		t.Fatalf("speed: %+v", r)
	}
	if err := w.Submit(command.Write{CommandID: "b", Mapping: start, Bool: true, Value: true, ExpiresAt: later()}, func(r worker.Result) { results <- r }); err != nil {
		t.Fatal(err)
	}
	if r := <-results; r.Status != command.Applied || r.Observed != true {
		t.Fatalf("start: %+v", r)
	}
	if got := server.Writes(); len(got) != 2 || got[0] != "registers 100=[425]" || got[1] != "coil 800=true" {
		t.Fatalf("writes: %v", got)
	}

	// A refused write fails without breaking the connection.
	server.Refuse(0x10, true)
	_ = w.Submit(command.Write{CommandID: "c", Mapping: speed, Words: []uint16{1}, ExpiresAt: later()}, func(r worker.Result) { results <- r })
	if r := <-results; r.Status != command.Failed || r.Rule != "plc-refused" {
		t.Fatalf("refused: %+v", r)
	}
	cancel()
	<-done
	// After the worker stopped a waiting command fails, unwritten.
	_ = w.Submit(command.Write{CommandID: "d", Mapping: speed, Words: []uint16{1}, ExpiresAt: later()}, func(r worker.Result) { results <- r })
	select {
	case r := <-results:
		t.Fatalf("nothing runs after stop: %+v", r)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestRefusesCommandsWhileThePLCIsAwayOrBusy(t *testing.T) {
	server, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	d := deployment(t, "plc-1", server)
	server.Close()
	w := worker.New(d, worker.Options{BackoffMin: 20 * time.Millisecond, BackoffMax: 40 * time.Millisecond})
	speed, _ := d.Mapping("m-speed")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go w.Run(ctx)
	eventually(t, "the PLC to be missing", func() bool { return w.Snapshot(false).Failures > 0 })
	results := make(chan worker.Result, 1)
	_ = w.Submit(command.Write{CommandID: "a", Mapping: speed, Words: []uint16{1}, ExpiresAt: later()}, func(r worker.Result) { results <- r })
	if r := <-results; r.Status != command.Failed || r.Rule != "plc-not-connected" {
		t.Fatalf("away: %+v", r)
	}

	// A worker that is not running takes at most its queue, then refuses.
	idle := worker.New(d, worker.Options{})
	busy := 0
	for range 20 {
		if err := idle.Submit(command.Write{Mapping: speed, ExpiresAt: later()}, func(worker.Result) {}); err != nil {
			busy++
		}
	}
	if busy != 4 {
		t.Fatalf("bounded command queue: %d refused", busy)
	}
}

// later is a deadline far enough ahead for any test command to be written.
func later() time.Time { return time.Now().Add(time.Minute) }

// TASK-907: a command is written only before its deadline, also after waiting in the
// queue or for the connection; one that waited past it fails and writes nothing.

// deadlineRig runs a worker against a test PLC and submits commands to it.
func deadlineRig(t *testing.T) (*modbustest.Server, config.Mapping, config.Mapping, func(command.Write) worker.Result) {
	t.Helper()
	server, speed, start, submit, _ := deadlineWorker(t)
	return server, speed, start, submit
}

func deadlineWorker(t *testing.T) (*modbustest.Server, config.Mapping, config.Mapping, func(command.Write) worker.Result, *worker.Worker) {
	t.Helper()
	server, err := modbustest.Start()
	if err != nil {
		t.Fatal(err)
	}
	d := deployment(t, "plc-1", server)
	w := worker.New(d, worker.Options{})
	speed, _ := d.Mapping("m-speed")
	start, _ := d.Mapping("m-start")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { w.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done; server.Close() })
	eventually(t, "online", func() bool { return w.Snapshot(false).State == worker.Online })
	submit := func(write command.Write) worker.Result {
		result := make(chan worker.Result, 1)
		if err := w.Submit(write, func(r worker.Result) { result <- r }); err != nil {
			t.Fatal(err)
		}
		return <-result
	}
	return server, speed, start, submit, w
}

func expiredResult(r worker.Result) bool {
	return r.Status == command.Failed && r.Rule == command.RuleExpired
}

func TestWritesACommandStillWithinItsDeadline(t *testing.T) {
	server, speed, _, submit := deadlineRig(t)
	if r := submit(command.Write{CommandID: "valid", Mapping: speed, Words: []uint16{425}, Value: 42.5, ExpiresAt: later()}); r.Status != command.Applied || r.Observed != 42.5 {
		t.Fatalf("valid: %+v", r)
	}
	if writes := server.Writes(); len(writes) != 1 {
		t.Fatalf("one write: %v", writes)
	}
}

func TestNeverWritesACommandWithoutADeadline(t *testing.T) {
	server, _, start, submit := deadlineRig(t)
	// It never came through command.Check: nothing unchecked reaches the PLC.
	if r := submit(command.Write{CommandID: "unchecked", Mapping: start, Bool: true}); !expiredResult(r) {
		t.Fatalf("unchecked: %+v", r)
	}
	if writes := server.Writes(); len(writes) != 0 {
		t.Fatalf("written: %v", writes)
	}
}

func TestNeverWritesACommandThatExpiredInTheQueue(t *testing.T) {
	server, speed, start, _, w := deadlineWorker(t)
	// Each request takes 300 ms (under the 500 ms timeout): the first command holds the queue.
	server.SetDelay(300 * time.Millisecond)
	first, queued := make(chan worker.Result, 1), make(chan worker.Result, 1)
	if err := w.Submit(command.Write{CommandID: "slow", Mapping: speed, Words: []uint16{100}, Value: 10.0, ExpiresAt: later()}, func(r worker.Result) { first <- r }); err != nil {
		t.Fatal(err)
	}
	if err := w.Submit(command.Write{CommandID: "queued", Mapping: start, Bool: true, ExpiresAt: time.Now().Add(150 * time.Millisecond)}, func(r worker.Result) { queued <- r }); err != nil {
		t.Fatal(err)
	}
	if r := <-first; r.Status != command.Applied {
		t.Fatalf("slow: %+v", r)
	}
	if r := <-queued; !expiredResult(r) {
		t.Fatalf("expired in the queue: %+v", r)
	}
	if got := server.Writes(); len(got) != 1 || got[0] != "registers 100=[100]" {
		t.Fatalf("only the valid command was written: %v", got)
	}
}

func TestNeverWritesACommandThatExpiredWaitingForTheConnection(t *testing.T) {
	server, _, start, submit, _ := deadlineWorker(t)
	server.SetDelay(300 * time.Millisecond)
	// A poll is in flight and holds the connection for ~300 ms; the command arrives now,
	// passes the first check, and its deadline passes while it waits for the connection.
	received := server.Received()
	eventually(t, "a poll in flight", func() bool { return server.Received() > received })
	if r := submit(command.Write{CommandID: "locked", Mapping: start, Bool: true, ExpiresAt: time.Now().Add(100 * time.Millisecond)}); !expiredResult(r) {
		t.Fatalf("expired waiting for the connection: %+v", r)
	}
	if got := server.Writes(); len(got) != 0 {
		t.Fatalf("an expired command was written: %v", got)
	}
}
