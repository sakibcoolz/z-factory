// Package supervisor runs one worker per active deployment. The set of workers follows the
// set of deployments: a new PLC gets a worker, a changed one gets a new worker, a removed
// one is stopped, and the others are not touched. A worker that panics is restarted after
// a delay; one that keeps panicking is marked degraded, and still only that PLC suffers.
package supervisor

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sort"
	"sync"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/worker"
)

// Panics in a row after which a worker is reported degraded.
const degradeAfterPanics = 3

// Runner is what the supervisor runs; *worker.Worker implements it.
type Runner interface {
	Run(ctx context.Context)
	Snapshot(withValues bool) worker.Snapshot
	Deployment() *config.Deployment
}

type entry struct {
	runner Runner
	cancel context.CancelFunc
	done   chan struct{}

	mu        sync.Mutex
	panics    int
	lastPanic string
}

// Supervisor owns the workers.
type Supervisor struct {
	ctx     context.Context
	build   func(*config.Deployment) Runner
	log     *slog.Logger
	restart time.Duration

	mu      sync.Mutex
	entries map[string]*entry
	started uint64
	stopped uint64
}

// New returns a supervisor whose workers live at most as long as ctx.
func New(ctx context.Context, build func(*config.Deployment) Runner, log *slog.Logger, restartDelay time.Duration) *Supervisor {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if restartDelay <= 0 {
		restartDelay = time.Second
	}
	return &Supervisor{ctx: ctx, build: build, log: log, restart: restartDelay, entries: map[string]*entry{}}
}

// Apply makes the running workers match the desired deployments, by PLC id.
func (s *Supervisor) Apply(desired map[string]*config.Deployment) {
	s.mu.Lock()
	var stop []*entry
	for plcID, running := range s.entries {
		want, ok := desired[plcID]
		current := running.runner.Deployment()
		if !ok || want.Checksum != current.Checksum || want.ConfigVersion != current.ConfigVersion {
			stop = append(stop, running)
			delete(s.entries, plcID)
		}
	}
	s.mu.Unlock()
	// Replaced and removed workers stop first, so a PLC never has two workers at once.
	for _, old := range stop {
		s.stop(old)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for plcID, deployment := range desired {
		if _, running := s.entries[plcID]; running || s.ctx.Err() != nil {
			continue
		}
		s.entries[plcID] = s.start(deployment)
	}
}

func (s *Supervisor) start(deployment *config.Deployment) *entry {
	ctx, cancel := context.WithCancel(s.ctx)
	e := &entry{runner: s.build(deployment), cancel: cancel, done: make(chan struct{})}
	s.started++
	s.log.Info("worker started", "plcId", deployment.PLCID, "plc", deployment.PLC.Name, "configVersion", deployment.ConfigVersion)
	go s.supervise(ctx, e)
	return e
}

func (s *Supervisor) stop(e *entry) {
	e.cancel()
	<-e.done
	s.mu.Lock()
	s.stopped++
	s.mu.Unlock()
	s.log.Info("worker stopped", "plcId", e.runner.Deployment().PLCID)
}

// supervise runs the worker until its context ends, restarting it after a panic.
func (s *Supervisor) supervise(ctx context.Context, e *entry) {
	defer close(e.done)
	for ctx.Err() == nil {
		panicked := s.runOnce(ctx, e)
		if !panicked {
			return
		}
		e.mu.Lock()
		panics := e.panics
		e.mu.Unlock()
		delay := s.restart * time.Duration(min(panics, 30))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (s *Supervisor) runOnce(ctx context.Context, e *entry) (panicked bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			panicked = true
			e.mu.Lock()
			e.panics++
			e.lastPanic = fmt.Sprint(recovered)
			e.mu.Unlock()
			s.log.Error("worker panicked", "plcId", e.runner.Deployment().PLCID, "panic", fmt.Sprint(recovered), "stack", string(debug.Stack()))
		}
	}()
	e.runner.Run(ctx)
	return false
}

// Status is one worker as the supervisor sees it.
type Status struct {
	worker.Snapshot
	Panics    int    `json:"panics"`
	LastPanic string `json:"lastPanic,omitempty"`
}

func (e *entry) status(withValues bool) Status {
	snapshot := e.runner.Snapshot(withValues)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.panics >= degradeAfterPanics {
		snapshot.State = worker.Degraded
	}
	return Status{Snapshot: snapshot, Panics: e.panics, LastPanic: e.lastPanic}
}

// Statuses lists every worker, by PLC name.
func (s *Supervisor) Statuses() []Status {
	s.mu.Lock()
	entries := make([]*entry, 0, len(s.entries))
	for _, e := range s.entries {
		entries = append(entries, e)
	}
	s.mu.Unlock()
	statuses := make([]Status, 0, len(entries))
	for _, e := range entries {
		statuses = append(statuses, e.status(false))
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].Name < statuses[j].Name })
	return statuses
}

// Status returns one worker with its values.
func (s *Supervisor) Status(plcID string) (Status, bool) {
	s.mu.Lock()
	e, ok := s.entries[plcID]
	s.mu.Unlock()
	if !ok {
		return Status{}, false
	}
	return e.status(true), true
}

// Counts returns how many workers run and how many were started and stopped so far.
func (s *Supervisor) Counts() (running int, started, stopped uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries), s.started, s.stopped
}

// Shutdown stops every worker, waiting at most until ctx ends.
func (s *Supervisor) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	entries := s.entries
	s.entries = map[string]*entry{}
	s.mu.Unlock()
	for _, e := range entries {
		e.cancel()
	}
	for _, e := range entries {
		select {
		case <-e.done:
		case <-ctx.Done():
			return fmt.Errorf("workers did not stop in time: %w", ctx.Err())
		}
	}
	return nil
}
