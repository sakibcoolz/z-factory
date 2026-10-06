package supervisor_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/command"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/supervisor"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/worker"
)

// runner stands in for a worker: it counts its runs and can be made to panic.
type runner struct {
	deployment *config.Deployment
	runs       atomic.Int32
	panic      atomic.Bool
}

func (r *runner) Run(ctx context.Context) {
	r.runs.Add(1)
	if r.panic.Load() {
		panic("boom")
	}
	<-ctx.Done()
}

func (r *runner) Snapshot(bool) worker.Snapshot {
	return worker.Snapshot{PLCID: r.deployment.PLCID, Name: r.deployment.PLC.Name, State: worker.Online}
}

func (r *runner) Deployment() *config.Deployment { return r.deployment }

func (r *runner) Submit(command.Write, func(worker.Result)) error { return nil }

type fleet struct {
	mu      sync.Mutex
	runners map[string][]*runner
	panicky map[string]bool
}

func (f *fleet) build(d *config.Deployment) supervisor.Runner {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := &runner{deployment: d}
	r.panic.Store(f.panicky[d.PLCID])
	f.runners[d.PLCID] = append(f.runners[d.PLCID], r)
	return r
}

func (f *fleet) built(id string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.runners[id])
}

func deployment(id, checksum string) *config.Deployment {
	return &config.Deployment{PLCID: id, Checksum: checksum, Body: config.Body{PLC: config.PLC{PLCID: id, Name: id}}}
}

func TestStartsReplacesAndStopsOnlyWhatChanged(t *testing.T) {
	f := &fleet{runners: map[string][]*runner{}, panicky: map[string]bool{}}
	s := supervisor.New(context.Background(), f.build, nil, 10*time.Millisecond)
	s.Apply(map[string]*config.Deployment{"a": deployment("a", "1"), "b": deployment("b", "1"), "c": deployment("c", "1")})
	if running, started, _ := s.Counts(); running != 3 || started != 3 {
		t.Fatalf("running %d started %d", running, started)
	}
	s.Apply(map[string]*config.Deployment{"a": deployment("a", "2"), "b": deployment("b", "1")})
	if f.built("a") != 2 || f.built("b") != 1 || f.built("c") != 1 {
		t.Fatalf("a replaced, b untouched, c stopped: %d %d %d", f.built("a"), f.built("b"), f.built("c"))
	}
	running, started, stopped := s.Counts()
	if running != 2 || started != 4 || stopped != 2 {
		t.Fatalf("running %d started %d stopped %d", running, started, stopped)
	}
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestIsolatesAWorkerThatPanics(t *testing.T) {
	f := &fleet{runners: map[string][]*runner{}, panicky: map[string]bool{"bad": true}}
	s := supervisor.New(context.Background(), f.build, nil, 5*time.Millisecond)
	s.Apply(map[string]*config.Deployment{"bad": deployment("bad", "1"), "good": deployment("good", "1")})
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, _ := s.Status("bad")
		if status.Panics >= 3 {
			if status.State != worker.Degraded || status.LastPanic != "boom" {
				t.Fatalf("bad %+v", status)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the panicking worker was not restarted")
		}
		time.Sleep(5 * time.Millisecond)
	}
	good, _ := s.Status("good")
	if good.State != worker.Online || good.Panics != 0 || f.runners["good"][0].runs.Load() != 1 {
		t.Fatalf("the other PLC is untouched: %+v", good)
	}
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
