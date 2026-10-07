// Package worker is one PLC's worker: it owns the connection to that PLC, polls the
// mappings of its deployment and hands each poll to a sink. A worker never touches another
// PLC, and a slow or absent PLC only delays its own worker.
package worker

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/codec"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/command"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/modbus"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/telemetry"
)

// States of a worker.
const (
	Disconnected = "DISCONNECTED"
	Connecting   = "CONNECTING"
	Online       = "ONLINE"
	Degraded     = "DEGRADED"
	Reconnecting = "RECONNECTING"
	Stopping     = "STOPPING"
)

// Client is the protocol connection a worker uses; *modbus.Client implements it.
type Client interface {
	Connect(ctx context.Context) error
	Close() error
	ReadBits(ctx context.Context, area string, address, count int) ([]bool, error)
	ReadRegisters(ctx context.Context, area string, address, count int) ([]uint16, error)
	WriteCoil(ctx context.Context, address int, value bool) error
	WriteRegisters(ctx context.Context, address int, words []uint16) error
}

// Options are what all workers share.
type Options struct {
	// Sink receives every poll; it must not block.
	Sink func(telemetry.Batch)
	// Limiter bounds the polls in flight across all workers (a global rate limit); nil is unbounded.
	Limiter chan struct{}
	// BackoffMin and BackoffMax bound the reconnect delay; it doubles with jitter.
	BackoffMin, BackoffMax time.Duration
	// NewClient opens the connection to the PLC; tests replace it.
	NewClient func(connection config.Connection) Client
	Now       func() time.Time
	Logger    *slog.Logger
}

func (o *Options) defaults() {
	if o.Sink == nil {
		o.Sink = func(telemetry.Batch) {}
	}
	if o.BackoffMin <= 0 {
		o.BackoffMin = 500 * time.Millisecond
	}
	if o.BackoffMax <= 0 {
		o.BackoffMax = 30 * time.Second
	}
	if o.NewClient == nil {
		o.NewClient = func(c config.Connection) Client {
			return modbus.New(c.Host, c.Port, c.UnitID, time.Duration(c.TimeoutMs)*time.Millisecond)
		}
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.DiscardHandler)
	}
}

type span struct {
	area     string
	address  int
	count    int
	mappings []config.Mapping
}

// plan groups mappings into few reads: neighbours of one area share a request.
func plan(mappings []config.Mapping) []span {
	var spans []span
	for _, area := range []string{"COIL", "DISCRETE_INPUT", "HOLDING_REGISTER", "INPUT_REGISTER"} {
		limit, gap := modbus.MaxRegisters, 16
		if area == "COIL" || area == "DISCRETE_INPUT" {
			limit, gap = modbus.MaxBits, 64
		}
		var of []config.Mapping
		for _, m := range mappings {
			if m.Area == area {
				of = append(of, m)
			}
		}
		sort.SliceStable(of, func(i, j int) bool { return of[i].Address < of[j].Address })
		for _, m := range of {
			end := m.Address + m.WordCount
			last := len(spans) - 1
			if last >= 0 && spans[last].area == area && m.Address <= spans[last].address+spans[last].count+gap &&
				end-spans[last].address <= limit {
				spans[last].count = max(spans[last].count, end-spans[last].address)
				spans[last].mappings = append(spans[last].mappings, m)
				continue
			}
			spans = append(spans, span{area: area, address: m.Address, count: m.WordCount, mappings: []config.Mapping{m}})
		}
	}
	return spans
}

// Worker polls one PLC.
type Worker struct {
	deployment *config.Deployment
	options    Options
	spans      []span
	poll       time.Duration

	// io serialises the use of the connection; mu guards the state below. They are never
	// held together the other way round, and health never waits for the network.
	io     sync.Mutex
	client Client

	commands chan job

	mu       sync.Mutex
	state    string
	values   map[string]telemetry.Value
	lastPoll time.Time
	// pollTook is how long the last complete poll took (wall clock, not the test clock).
	pollTook   time.Duration
	lastError  string
	errorAt    time.Time
	polls      uint64
	failures   uint64
	reconnects uint64
	connected  bool
}

// New returns a worker for one deployment; it does nothing until Run.
func New(deployment *config.Deployment, options Options) *Worker {
	options.defaults()
	values := make(map[string]telemetry.Value, len(deployment.Mappings))
	for _, m := range deployment.Mappings {
		values[m.ID] = telemetry.Value{MappingID: m.ID, Name: m.Name, Value: nil, Quality: telemetry.Disconnected}
	}
	return &Worker{
		deployment: deployment,
		options:    options,
		spans:      plan(deployment.Mappings),
		poll:       time.Duration(deployment.Connection.PollIntervalMs) * time.Millisecond,
		state:      Disconnected,
		values:     values,
		commands:   make(chan job, commandQueue),
	}
}

// commandQueue bounds the commands waiting for one PLC; more are refused as busy.
const commandQueue = 16

// Result is the outcome of a command write.
type Result struct {
	Status   string
	Rule     string
	Reason   string
	Observed any
}

type job struct {
	write command.Write
	done  func(Result)
}

// Submit queues a checked command for this PLC without waiting; done is called once with
// the outcome. It returns command.ErrBusy when the PLC already has too many waiting.
func (w *Worker) Submit(write command.Write, done func(Result)) error {
	select {
	case w.commands <- job{write: write, done: done}:
		return nil
	default:
		return command.ErrBusy
	}
}

// commandLoop writes queued commands between polls; it ends with ctx. Commands still
// waiting then fail: nothing is written after the worker stopped.
func (w *Worker) commandLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			for {
				select {
				case next := <-w.commands:
					next.done(Result{Status: command.Failed, Rule: "plc-worker-stopped", Reason: "the PLC worker stopped before the write"})
				default:
					return
				}
			}
		case next := <-w.commands:
			next.done(w.execute(ctx, next.write))
		}
	}
}

// execute writes one command tag and reads it back. The PLC program decides what follows;
// its feedback arrives with the next polls.
func (w *Worker) execute(ctx context.Context, write command.Write) Result {
	w.mu.Lock()
	state := w.state
	w.mu.Unlock()
	if state != Online && state != Degraded {
		return Result{Status: command.Failed, Rule: "plc-not-connected", Reason: "the PLC is " + state}
	}
	m := write.Mapping
	w.io.Lock()
	defer w.io.Unlock()
	var observed any
	var err error
	if codec.IsBool(m.DataType) {
		if err = w.client.WriteCoil(ctx, m.Address, write.Bool); err == nil {
			var bits []bool
			if bits, err = w.client.ReadBits(ctx, "COIL", m.Address, 1); err == nil {
				observed = bits[0]
			}
		}
	} else if err = w.client.WriteRegisters(ctx, m.Address, write.Words); err == nil {
		var words []uint16
		if words, err = w.client.ReadRegisters(ctx, "HOLDING_REGISTER", m.Address, m.WordCount); err == nil {
			observed, err = codec.Decode(words, m.Encoding())
		}
	}
	if err != nil {
		w.fail(err)
		if modbus.IsException(err) {
			return Result{Status: command.Failed, Rule: "plc-refused", Reason: err.Error()}
		}
		// The connection is in an unknown state; the poll loop reconnects.
		_ = w.client.Close()
		return Result{Status: command.Failed, Rule: "plc-write-failed", Reason: err.Error()}
	}
	return Result{Status: command.Applied, Observed: observed}
}

// Deployment returns what the worker runs.
func (w *Worker) Deployment() *config.Deployment { return w.deployment }

func (w *Worker) setState(state string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.state = state
}

func (w *Worker) fail(err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.lastError = err.Error()
	w.errorAt = w.options.Now()
	w.failures++
}

// degrade keeps the last values but says they can no longer be trusted.
func (w *Worker) degrade(mappings []config.Mapping, quality string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, m := range mappings {
		value := w.values[m.ID]
		value.Quality = quality
		w.values[m.ID] = value
	}
}

// backoff is the delay before attempt n (1-based): doubling, capped, with full jitter.
func (w *Worker) backoff(attempt int) time.Duration {
	delay := w.options.BackoffMin << min(attempt-1, 16)
	if delay > w.options.BackoffMax || delay <= 0 {
		delay = w.options.BackoffMax
	}
	return delay/2 + rand.N(delay/2+1)
}

func sleep(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// Run polls until the context ends. It reconnects with backoff after the PLC goes away.
func (w *Worker) Run(ctx context.Context) {
	client := w.options.NewClient(w.deployment.Connection)
	w.io.Lock()
	w.client = client
	w.io.Unlock()
	defer func() {
		w.setState(Stopping)
		_ = w.closeClient()
		w.degrade(w.deployment.Mappings, telemetry.Disconnected)
	}()
	log := w.options.Logger.With("plcId", w.deployment.PLCID, "plc", w.deployment.PLC.Name)
	// The command writer lives exactly as long as this run, also when the run panics.
	commandCtx, stopCommands := context.WithCancel(ctx)
	var commands sync.WaitGroup
	commands.Go(func() { w.commandLoop(commandCtx) })
	defer commands.Wait()
	defer stopCommands()

	attempt := 0
	for ctx.Err() == nil {
		if attempt == 0 {
			w.setState(Connecting)
		} else {
			w.setState(Reconnecting)
		}
		w.io.Lock()
		connectCtx, cancel := context.WithTimeout(ctx, time.Duration(w.deployment.Connection.TimeoutMs)*time.Millisecond)
		err := client.Connect(connectCtx)
		cancel()
		w.io.Unlock()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			attempt++
			w.fail(err)
			w.degrade(w.deployment.Mappings, telemetry.Disconnected)
			w.setState(Disconnected)
			delay := w.backoff(attempt)
			log.Warn("plc not reachable", "error", err.Error(), "retryIn", delay.String())
			if !sleep(ctx, delay) {
				return
			}
			continue
		}
		w.mu.Lock()
		if w.connected || attempt > 0 {
			w.reconnects++
		}
		w.connected = true
		w.mu.Unlock()
		attempt = 0
		log.Info("plc online")
		if lost := w.pollLoop(ctx); lost != nil {
			attempt = 1
			w.fail(lost)
			w.degrade(w.deployment.Mappings, telemetry.Disconnected)
			w.setState(Reconnecting)
			log.Warn("plc connection lost", "error", lost.Error())
			if !sleep(ctx, w.backoff(attempt)) {
				return
			}
		}
	}
}

// pollLoop polls every interval while the connection holds; it returns the error that broke it.
func (w *Worker) pollLoop(ctx context.Context) error {
	ticker := time.NewTicker(w.poll)
	defer ticker.Stop()
	for {
		if err := w.pollOnce(ctx); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (w *Worker) acquire(ctx context.Context) bool {
	if w.options.Limiter == nil {
		return true
	}
	select {
	case w.options.Limiter <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (w *Worker) release() {
	if w.options.Limiter != nil {
		<-w.options.Limiter
	}
}

// pollOnce reads every span. An exception spoils only its span (BAD, DEGRADED); a broken
// connection ends the poll and is returned.
func (w *Worker) pollOnce(ctx context.Context) error {
	if !w.acquire(ctx) {
		return nil
	}
	defer w.release()
	at := w.options.Now()
	started := time.Now()
	refused := false
	for _, s := range w.spans {
		if ctx.Err() != nil {
			return nil
		}
		w.io.Lock()
		values, err := w.read(ctx, s)
		w.io.Unlock()
		if err != nil {
			if modbus.IsException(err) {
				refused = true
				w.fail(err)
				w.degrade(s.mappings, telemetry.Bad)
				continue
			}
			if ctx.Err() != nil {
				return nil
			}
			_ = w.closeClient()
			return err
		}
		w.mu.Lock()
		for _, value := range values {
			value.At = at
			w.values[value.MappingID] = value
		}
		w.mu.Unlock()
	}
	w.mu.Lock()
	w.polls++
	w.lastPoll = at
	w.pollTook = time.Since(started)
	if refused {
		w.state = Degraded
	} else {
		w.state = Online
	}
	batch := telemetry.Batch{PLCID: w.deployment.PLCID, ConfigVersion: w.deployment.ConfigVersion, At: at, Values: w.valuesLocked()}
	w.mu.Unlock()
	w.options.Sink(batch)
	return nil
}

func (w *Worker) closeClient() error {
	w.io.Lock()
	defer w.io.Unlock()
	return w.client.Close()
}

// read reads one span and decodes its mappings; called with the io lock held.
func (w *Worker) read(ctx context.Context, s span) ([]telemetry.Value, error) {
	var values []telemetry.Value
	if s.area == "COIL" || s.area == "DISCRETE_INPUT" {
		bits, err := w.client.ReadBits(ctx, s.area, s.address, s.count)
		if err != nil {
			return nil, err
		}
		for _, m := range s.mappings {
			values = append(values, telemetry.Value{MappingID: m.ID, Name: m.Name, Value: bits[m.Address-s.address], Quality: telemetry.Good})
		}
		return values, nil
	}
	words, err := w.client.ReadRegisters(ctx, s.area, s.address, s.count)
	if err != nil {
		return nil, err
	}
	for _, m := range s.mappings {
		start := m.Address - s.address
		value, err := codec.Decode(words[start:start+m.WordCount], m.Encoding())
		if err != nil {
			values = append(values, telemetry.Value{MappingID: m.ID, Name: m.Name, Quality: telemetry.Bad})
			continue
		}
		values = append(values, telemetry.Value{MappingID: m.ID, Name: m.Name, Value: value, Quality: telemetry.Good})
	}
	return values, nil
}

func (w *Worker) valuesLocked() []telemetry.Value {
	values := make([]telemetry.Value, 0, len(w.deployment.Mappings))
	for _, m := range w.deployment.Mappings {
		values = append(values, w.values[m.ID])
	}
	return values
}

// Snapshot is what health shows about one worker.
type Snapshot struct {
	PLCID         string     `json:"plcId"`
	Name          string     `json:"name"`
	State         string     `json:"state"`
	Endpoint      string     `json:"endpoint"`
	ConfigVersion int64      `json:"configVersion"`
	Checksum      string     `json:"checksum"`
	Mappings      int        `json:"mappings"`
	Writable      int        `json:"writable"`
	Polls         uint64     `json:"polls"`
	Failures      uint64     `json:"failures"`
	Reconnects    uint64     `json:"reconnects"`
	LastPollAt    *time.Time `json:"lastPollAt"`
	// LastPollMs is how long the last complete poll took, in milliseconds.
	LastPollMs  float64           `json:"lastPollMs"`
	LastError   string            `json:"lastError,omitempty"`
	LastErrorAt *time.Time        `json:"lastErrorAt,omitempty"`
	Values      []telemetry.Value `json:"values,omitempty"`
}

// Snapshot returns the worker's state; with values, each carries its quality now: a good
// value nobody has confirmed for three poll intervals is STALE.
func (w *Worker) Snapshot(withValues bool) Snapshot {
	w.mu.Lock()
	defer w.mu.Unlock()
	writable := 0
	for _, m := range w.deployment.Mappings {
		if m.Writable() {
			writable++
		}
	}
	c := w.deployment.Connection
	snapshot := Snapshot{
		PLCID:         w.deployment.PLCID,
		Name:          w.deployment.PLC.Name,
		State:         w.state,
		Endpoint:      net.JoinHostPort(c.Host, strconv.Itoa(c.Port)),
		ConfigVersion: w.deployment.ConfigVersion,
		Checksum:      w.deployment.Checksum,
		Mappings:      len(w.deployment.Mappings),
		Writable:      writable,
		Polls:         w.polls,
		Failures:      w.failures,
		Reconnects:    w.reconnects,
		LastError:     w.lastError,
		LastPollMs:    float64(w.pollTook.Microseconds()) / 1000,
	}
	if !w.lastPoll.IsZero() {
		at := w.lastPoll
		snapshot.LastPollAt = &at
	}
	if !w.errorAt.IsZero() {
		at := w.errorAt
		snapshot.LastErrorAt = &at
	}
	if withValues {
		now := w.options.Now()
		snapshot.Values = w.valuesLocked()
		for i, value := range snapshot.Values {
			if value.Quality == telemetry.Good && now.Sub(value.At) > 3*w.poll {
				snapshot.Values[i].Quality = telemetry.Stale
			}
		}
	}
	return snapshot
}
