// Package agent wires the Z-Factory Thin Client Agent together: the deployment files, the
// supervised PLC workers, the telemetry queue and the health endpoint.
package agent

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/deploy"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/health"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/supervisor"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/telemetry"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/uplink"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/worker"
)

// Settings configure the agent; zero values take the defaults.
type Settings struct {
	Dir                string
	HealthAddr         string
	ScanInterval       time.Duration
	Settle             time.Duration
	QueueCapacity      int
	MaxConcurrentPolls int
	ShutdownTimeout    time.Duration
	BackoffMin         time.Duration
	BackoffMax         time.Duration
	Version            string
	Logger             *slog.Logger
	// NewClient replaces the Modbus client (tests).
	NewClient func(config.Connection) worker.Client
	// Uplink connects to the cloud over MQTT; nil runs the agent without one.
	Uplink *uplink.Settings
}

func (s *Settings) defaults() {
	if s.HealthAddr == "" {
		s.HealthAddr = "127.0.0.1:9180"
	}
	if s.ScanInterval <= 0 {
		s.ScanInterval = 2 * time.Second
	}
	if s.Settle < 0 {
		s.Settle = 0
	}
	if s.QueueCapacity <= 0 {
		s.QueueCapacity = 10_000
	}
	if s.MaxConcurrentPolls <= 0 {
		s.MaxConcurrentPolls = 64
	}
	if s.ShutdownTimeout <= 0 {
		s.ShutdownTimeout = 10 * time.Second
	}
	if s.Version == "" {
		s.Version = "dev"
	}
	if s.Logger == nil {
		s.Logger = slog.New(slog.DiscardHandler)
	}
}

// Agent is a running agent.
type Agent struct {
	settings   Settings
	store      *deploy.Store
	supervisor *supervisor.Supervisor
	queue      *telemetry.Queue
	uplink     *uplink.Uplink
	listener   net.Listener
	server     *http.Server
	startedAt  time.Time
	cancel     context.CancelFunc
	done       chan struct{}
	scans      atomic.Uint64
	discarded  atomic.Uint64
	stopOnce   sync.Once
	stopErr    error
}

// Start opens the directories, binds the health endpoint and starts scanning. The agent
// runs until Stop or until ctx ends.
func Start(ctx context.Context, settings Settings) (*Agent, error) {
	settings.defaults()
	if settings.Dir == "" {
		return nil, errors.New("the agent needs a directory")
	}
	store, err := deploy.Open(settings.Dir, settings.Settle)
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", settings.HealthAddr)
	if err != nil {
		return nil, err
	}
	runCtx, cancel := context.WithCancel(ctx)
	a := &Agent{
		settings:  settings,
		store:     store,
		queue:     telemetry.NewQueue(settings.QueueCapacity),
		listener:  listener,
		startedAt: time.Now(),
		cancel:    cancel,
		done:      make(chan struct{}),
	}
	limiter := make(chan struct{}, settings.MaxConcurrentPolls)
	options := worker.Options{
		Sink:       func(batch telemetry.Batch) { a.queue.Push(batch) },
		Limiter:    limiter,
		BackoffMin: settings.BackoffMin,
		BackoffMax: settings.BackoffMax,
		NewClient:  settings.NewClient,
		Logger:     settings.Logger,
	}
	a.supervisor = supervisor.New(runCtx, func(d *config.Deployment) supervisor.Runner {
		return worker.New(d, options)
	}, settings.Logger, time.Second)
	if settings.Uplink != nil {
		uplinkSettings := *settings.Uplink
		uplinkSettings.Version = settings.Version
		a.uplink, err = uplink.Start(runCtx, uplinkSettings, a.queue, a.supervisor, settings.Logger)
		if err != nil {
			cancel()
			_ = listener.Close()
			return nil, err
		}
	}
	a.server = &http.Server{
		Handler: health.Handler(health.Source{
			Version:    settings.Version,
			StartedAt:  a.startedAt,
			Store:      store,
			Supervisor: a.supervisor,
			Queue:      a.queue,
			Uplink:     a.uplinkStatus,
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() { _ = a.server.Serve(listener) }()

	var loops sync.WaitGroup
	loops.Go(func() { a.scanLoop(runCtx) })
	if a.uplink == nil {
		loops.Go(func() { a.drain(runCtx) })
	}
	go func() {
		loops.Wait()
		close(a.done)
	}()
	settings.Logger.Info("agent started", "dir", settings.Dir, "health", listener.Addr().String(), "version", settings.Version)
	return a, nil
}

// Supervisor returns the agent's supervisor, for status.
func (a *Agent) Supervisor() *supervisor.Supervisor { return a.supervisor }

// HealthAddr returns the address the health endpoint listens on.
func (a *Agent) HealthAddr() string { return a.listener.Addr().String() }

// Scan applies the files now instead of waiting for the next scan.
func (a *Agent) Scan() {
	desired, err := a.store.Scan()
	if err != nil {
		a.settings.Logger.Error("scan failed", "error", err.Error())
	}
	if desired != nil {
		a.supervisor.Apply(desired)
	}
	a.scans.Add(1)
}

func (a *Agent) scanLoop(ctx context.Context) {
	a.Scan()
	ticker := time.NewTicker(a.settings.ScanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.Scan()
		}
	}
}

// drain takes telemetry off the queue when no uplink is configured: it is counted and
// dropped, so the queue shows real backpressure only when there is a consumer.
func (a *Agent) drain(ctx context.Context) {
	for {
		if _, ok := a.queue.Pop(ctx); !ok {
			return
		}
		a.discarded.Add(1)
	}
}

func (a *Agent) uplinkStatus() map[string]any {
	if a.uplink != nil {
		return a.uplink.Status()
	}
	return map[string]any{"configured": false, "discardedBatches": a.discarded.Load()}
}

// Status returns what /v1/status shows.
func (a *Agent) Status() health.AgentStatus {
	return health.Source{
		Version: a.settings.Version, StartedAt: a.startedAt, Store: a.store, Supervisor: a.supervisor, Queue: a.queue,
		Uplink: a.uplinkStatus,
	}.Status()
}

// Stop stops scanning, stops every worker within the shutdown timeout and closes health.
func (a *Agent) Stop() error {
	a.stopOnce.Do(func() {
		a.cancel()
		<-a.done
		ctx, cancel := context.WithTimeout(context.Background(), a.settings.ShutdownTimeout)
		defer cancel()
		a.stopErr = errors.Join(a.supervisor.Shutdown(ctx), a.server.Shutdown(ctx))
		if a.uplink != nil {
			a.uplink.Stop()
		}
		a.settings.Logger.Info("agent stopped")
	})
	return a.stopErr
}
