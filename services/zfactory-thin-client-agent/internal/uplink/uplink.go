// Package uplink connects the agent to the cloud over MQTT (TASK-503b,
// docs/thin-client-agent.md → MQTT): telemetry, PLC state and a heartbeat go up, commands
// come down and are answered with acknowledgements. Topics, under
// zfactory/{siteId}/{agentId}/:
//
//	telemetry/{plcId}   one poll of a PLC                  QoS (default 1), not retained
//	state/{plcId}       a PLC worker's state               QoS 1, retained (cleared when the PLC goes)
//	agent/heartbeat     the agent is alive, with counters  QoS 0, every interval
//	agent/status        online / offline (also the will)   QoS 1, retained
//	command/{plcId}     a command for a PLC (subscribed)   QoS 1
//	ack/{plcId}         what became of a command           QoS 1, not retained
//
// A fixed pool of publishers takes telemetry off the shared queue; nothing is published
// per PLC on its own connection. While the broker cannot be reached the publishers put
// the batches in the spool (TASK-503c); after it returns, one replayer sends the backlog
// at a fixed rate beside the live publishers, marked "replayed", so live telemetry is
// never held up by it. Without a spool the publishers wait and the queue drops its oldest.
package uplink

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/command"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/spool"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/supervisor"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/telemetry"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/worker"
)

// Settings configure the uplink. Credentials are references (a file), never a value in a
// deployment file or a log line.
type Settings struct {
	BrokerURL    string
	ClientID     string
	SiteID       string
	AgentID      string
	Username     string
	PasswordFile string
	CAFile       string
	CertFile     string
	KeyFile      string
	TelemetryQoS byte
	Publishers   int
	Heartbeat    time.Duration
	// StateRefresh republishes every PLC's state at least this often.
	StateRefresh   time.Duration
	PublishTimeout time.Duration
	KeepAlive      time.Duration
	// ReplayRate is how many spooled batches are sent per second after a reconnect.
	ReplayRate int
	// Version is the agent's version, for the heartbeat.
	Version string
}

var segment = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (s *Settings) defaults() error {
	if s.BrokerURL == "" {
		return errors.New("the MQTT broker URL is missing")
	}
	broker, err := url.Parse(s.BrokerURL)
	if err != nil || broker.Host == "" {
		return fmt.Errorf("the MQTT broker URL %q is not a URL", redact(s.BrokerURL))
	}
	if broker.User != nil {
		return errors.New("put MQTT credentials in the username and password file, not in the broker URL")
	}
	switch broker.Scheme {
	case "tcp", "mqtt", "ssl", "tls", "mqtts":
	default:
		return fmt.Errorf("MQTT scheme %q is not supported (tcp, mqtt, ssl, tls, mqtts)", broker.Scheme)
	}
	if !segment.MatchString(s.SiteID) || !segment.MatchString(s.AgentID) {
		return errors.New("the site and agent ids are 1-64 of A-Z a-z 0-9 _ -")
	}
	if s.ClientID == "" {
		s.ClientID = "zfactory-agent-" + s.SiteID + "-" + s.AgentID
	}
	if s.TelemetryQoS > 1 {
		s.TelemetryQoS = 1
	}
	if s.Publishers <= 0 {
		s.Publishers = 4
	}
	if s.Heartbeat <= 0 {
		s.Heartbeat = 10 * time.Second
	}
	if s.StateRefresh <= 0 {
		s.StateRefresh = time.Minute
	}
	if s.PublishTimeout <= 0 {
		s.PublishTimeout = 5 * time.Second
	}
	if s.KeepAlive <= 0 {
		s.KeepAlive = 30 * time.Second
	}
	if s.ReplayRate <= 0 {
		s.ReplayRate = 50
	}
	return nil
}

func redact(raw string) string {
	broker, err := url.Parse(raw)
	if err != nil {
		return "(unparsable)"
	}
	return broker.Scheme + "://" + broker.Host
}

// Source is what the uplink reads from the agent: the PLC workers.
type Source interface {
	Statuses() []supervisor.Status
	Commander(plcID string) (supervisor.Commander, bool)
}

// Counters of the uplink.
type counters struct {
	published, publishErrors, connects, connectionsLost                  atomic.Uint64
	spooled, spoolErrors, lost, replayedOut                              atomic.Uint64
	received, accepted, rejected, applied, failed, duplicates, ackErrors atomic.Uint64
}

// Uplink is a running MQTT connection.
type Uplink struct {
	settings  Settings
	queue     *telemetry.Queue
	spool     spool.Store
	source    Source
	log       *slog.Logger
	client    mqtt.Client
	commands  *command.Cache
	startedAt time.Time
	prefix    string
	counters  counters

	mu        sync.Mutex
	lastError string
	states    map[string]string

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Start connects in the background (retrying until the broker answers) and starts the
// publishers, the heartbeat and the command subscription.
// The spool is optional: nil keeps the 503b behaviour of waiting and dropping the oldest.
func Start(ctx context.Context, settings Settings, queue *telemetry.Queue, source Source, store spool.Store, log *slog.Logger) (*Uplink, error) {
	if err := settings.defaults(); err != nil {
		return nil, err
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	u := &Uplink{
		settings:  settings,
		queue:     queue,
		spool:     store,
		source:    source,
		log:       log.With("component", "uplink"),
		commands:  command.NewCache(10_000, 24*time.Hour),
		startedAt: time.Now(),
		prefix:    "zfactory/" + settings.SiteID + "/" + settings.AgentID,
		states:    map[string]string{},
	}
	options, err := u.options()
	if err != nil {
		return nil, err
	}
	u.client = mqtt.NewClient(options)
	u.client.Connect() // Retries in the background (ConnectRetry); never blocks the agent.

	runCtx, cancel := context.WithCancel(ctx)
	u.cancel = cancel
	for range settings.Publishers {
		u.wg.Go(func() { u.publish(runCtx) })
	}
	u.wg.Go(func() { u.beat(runCtx) })
	if store != nil {
		u.wg.Go(func() { u.replay(runCtx) })
	}
	u.log.Info("uplink started", "broker", redact(settings.BrokerURL), "clientId", settings.ClientID, "prefix", u.prefix)
	return u, nil
}

func (u *Uplink) options() (*mqtt.ClientOptions, error) {
	s := u.settings
	options := mqtt.NewClientOptions().
		AddBroker(s.BrokerURL).
		SetClientID(s.ClientID).
		// A persistent session keeps the command subscription across reconnects; stale
		// commands are refused by their expiresAt.
		SetCleanSession(false).
		SetAutoReconnect(true).
		SetConnectRetry(true).
		SetConnectRetryInterval(2*time.Second).
		SetMaxReconnectInterval(30*time.Second).
		SetKeepAlive(s.KeepAlive).
		SetConnectTimeout(10*time.Second).
		SetWriteTimeout(s.PublishTimeout).
		// Handlers run one at a time and never block: no goroutine per message.
		SetOrderMatters(true).
		SetWill(u.prefix+"/agent/status", string(u.statusPayload("offline")), 1, true).
		SetOnConnectHandler(u.connected).
		SetConnectionLostHandler(func(_ mqtt.Client, err error) {
			u.counters.connectionsLost.Add(1)
			u.setError("connection lost: " + err.Error())
			u.log.Warn("broker connection lost", "error", err.Error())
		})
	if s.Username != "" {
		options.SetUsername(s.Username)
	}
	if s.PasswordFile != "" {
		password, err := os.ReadFile(s.PasswordFile)
		if err != nil {
			return nil, fmt.Errorf("the MQTT password file cannot be read: %w", err)
		}
		options.SetPassword(strings.TrimRight(string(password), "\r\n"))
	}
	scheme, _ := url.Parse(s.BrokerURL)
	if secure := scheme.Scheme == "ssl" || scheme.Scheme == "tls" || scheme.Scheme == "mqtts"; secure || s.CAFile != "" {
		config := &tls.Config{MinVersion: tls.VersionTLS12}
		if s.CAFile != "" {
			pem, err := os.ReadFile(s.CAFile)
			if err != nil {
				return nil, fmt.Errorf("the MQTT CA file cannot be read: %w", err)
			}
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM(pem) {
				return nil, errors.New("the MQTT CA file holds no certificate")
			}
			config.RootCAs = pool
		}
		if s.CertFile != "" || s.KeyFile != "" {
			certificate, err := tls.LoadX509KeyPair(s.CertFile, s.KeyFile)
			if err != nil {
				return nil, fmt.Errorf("the MQTT client certificate cannot be loaded: %w", err)
			}
			config.Certificates = []tls.Certificate{certificate}
		}
		options.SetTLSConfig(config)
	}
	return options, nil
}

func (u *Uplink) setError(message string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.lastError = message
}

func (u *Uplink) connected(client mqtt.Client) {
	u.counters.connects.Add(1)
	u.log.Info("broker connected", "broker", redact(u.settings.BrokerURL))
	if token := client.Subscribe(u.prefix+"/command/+", 1, u.onCommand); !token.WaitTimeout(u.settings.PublishTimeout) || token.Error() != nil {
		u.setError(fmt.Sprintf("subscribing to commands failed: %v", token.Error()))
		u.log.Error("subscribing to commands failed", "error", fmt.Sprint(token.Error()))
	}
	client.Publish(u.prefix+"/agent/status", 1, true, u.statusPayload("online"))
	// Every PLC's state is published again after a reconnect.
	u.mu.Lock()
	u.states = map[string]string{}
	u.mu.Unlock()
}

func (u *Uplink) statusPayload(status string) []byte {
	payload, _ := json.Marshal(map[string]any{
		"schema": "zfactory.agent-status", "version": 1, "siteId": u.settings.SiteID, "agentId": u.settings.AgentID,
		"status": status, "agentVersion": u.settings.Version, "at": time.Now().UTC(),
	})
	return payload
}

// Connected reports whether the broker connection is up.
func (u *Uplink) Connected() bool { return u.client != nil && u.client.IsConnectionOpen() }

func (u *Uplink) send(topic string, qos byte, retained bool, payload []byte, wait bool) bool {
	if !u.Connected() {
		return false
	}
	token := u.client.Publish(topic, qos, retained, payload)
	if !wait {
		return true
	}
	if !token.WaitTimeout(u.settings.PublishTimeout) || token.Error() != nil {
		u.counters.publishErrors.Add(1)
		u.setError(fmt.Sprintf("publishing to %s failed: %v", topic, token.Error()))
		return false
	}
	return true
}

// publishBatch sends one batch and waits for the broker to take it.
func (u *Uplink) publishBatch(batch telemetry.Batch, replayed bool) bool {
	payload, err := json.Marshal(struct {
		Schema   string `json:"schema"`
		Version  int    `json:"version"`
		SiteID   string `json:"siteId"`
		AgentID  string `json:"agentId"`
		Replayed bool   `json:"replayed,omitempty"`
		telemetry.Batch
	}{"zfactory.telemetry", 1, u.settings.SiteID, u.settings.AgentID, replayed, batch})
	if err != nil {
		return true // Nothing to keep: it would never encode.
	}
	return u.send(u.prefix+"/telemetry/"+batch.PLCID, u.settings.TelemetryQoS, false, payload, true)
}

// publish is one publisher of the pool. A batch it cannot deliver goes to the spool.
func (u *Uplink) publish(ctx context.Context) {
	for ctx.Err() == nil {
		if !u.Connected() && u.spool == nil {
			timer := time.NewTimer(200 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			continue
		}
		batch, ok := u.queue.Pop(ctx)
		if !ok {
			return
		}
		if u.Connected() && u.publishBatch(batch, false) {
			u.counters.published.Add(1)
			continue
		}
		u.keep(batch)
	}
}

// keep puts an undelivered batch in the spool. A failing spool costs the batch, never a worker.
func (u *Uplink) keep(batch telemetry.Batch) {
	if u.spool == nil {
		u.counters.lost.Add(1)
		return
	}
	if err := u.spool.Put(batch); err != nil {
		u.counters.spoolErrors.Add(1)
		u.counters.lost.Add(1)
		u.setError("spooling failed: " + err.Error())
		return
	}
	u.counters.spooled.Add(1)
}

// replay sends the spooled backlog, oldest first, at the replay rate while connected.
func (u *Uplink) replay(ctx context.Context) {
	ticker := time.NewTicker(time.Second / time.Duration(u.settings.ReplayRate))
	defer ticker.Stop()
	prune := time.NewTicker(time.Minute)
	defer prune.Stop()
	wait := func(delay time.Duration) bool {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return true
		}
	}
	for ctx.Err() == nil {
		select {
		case <-prune.C:
			if pruner, ok := u.spool.(interface{ Prune() (int, error) }); ok {
				_, _ = pruner.Prune()
			}
		default:
		}
		if !u.Connected() {
			if !wait(500 * time.Millisecond) {
				return
			}
			continue
		}
		entries, err := u.spool.Peek(50)
		if err != nil || len(entries) == 0 {
			if !wait(500 * time.Millisecond) {
				return
			}
			continue
		}
		var sent []uint64
		for _, entry := range entries {
			select {
			case <-ctx.Done():
				_ = u.spool.Delete(sent)
				return
			case <-ticker.C:
			}
			if entry.Batch.PLCID == "" {
				// Unreadable: nothing to send, only to remove.
				sent = append(sent, entry.Key)
				continue
			}
			if !u.Connected() || !u.publishBatch(entry.Batch, true) {
				break
			}
			sent = append(sent, entry.Key)
			u.counters.replayedOut.Add(1)
		}
		if err := u.spool.Delete(sent); err != nil {
			u.counters.spoolErrors.Add(1)
		}
	}
}

// beat publishes the heartbeat and the PLC states that changed (and all of them now and then).
func (u *Uplink) beat(ctx context.Context) {
	ticker := time.NewTicker(u.settings.Heartbeat)
	defer ticker.Stop()
	refreshEvery := max(1, int(u.settings.StateRefresh/u.settings.Heartbeat))
	for tick := 0; ; tick++ {
		if u.Connected() {
			u.publishStates(tick%refreshEvery == 0)
			u.publishHeartbeat()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (u *Uplink) publishStates(all bool) {
	statuses := u.source.Statuses()
	seen := map[string]bool{}
	for _, status := range statuses {
		seen[status.PLCID] = true
		key := fmt.Sprintf("%s|%d|%s", status.State, status.ConfigVersion, status.LastError)
		u.mu.Lock()
		changed := u.states[status.PLCID] != key
		u.mu.Unlock()
		if !changed && !all {
			continue
		}
		payload, _ := json.Marshal(map[string]any{
			"schema": "zfactory.plc-state", "version": 1, "siteId": u.settings.SiteID, "agentId": u.settings.AgentID,
			"plcId": status.PLCID, "name": status.Name, "state": status.State, "configVersion": status.ConfigVersion,
			"endpoint": status.Endpoint, "lastPollAt": status.LastPollAt, "lastError": status.LastError,
			"reconnects": status.Reconnects, "at": time.Now().UTC(),
		})
		if u.send(u.prefix+"/state/"+status.PLCID, 1, true, payload, false) {
			u.mu.Lock()
			u.states[status.PLCID] = key
			u.mu.Unlock()
		}
	}
	// A PLC that is no longer deployed leaves no retained state behind.
	u.mu.Lock()
	var gone []string
	for plcID := range u.states {
		if !seen[plcID] {
			gone = append(gone, plcID)
		}
	}
	u.mu.Unlock()
	for _, plcID := range gone {
		if u.send(u.prefix+"/state/"+plcID, 1, true, nil, false) {
			u.mu.Lock()
			delete(u.states, plcID)
			u.mu.Unlock()
		}
	}
}

func (u *Uplink) publishHeartbeat() {
	statuses := u.source.Statuses()
	byState := map[string]int{}
	for _, status := range statuses {
		byState[status.State]++
	}
	queue := u.queue.Stats()
	backlog := 0
	if u.spool != nil {
		backlog = u.spool.Stats().Entries
	}
	payload, _ := json.Marshal(map[string]any{
		"schema": "zfactory.agent-heartbeat", "version": 1, "siteId": u.settings.SiteID, "agentId": u.settings.AgentID,
		"agentVersion": u.settings.Version, "uptimeS": int64(time.Since(u.startedAt).Seconds()),
		"workers": len(statuses), "byState": byState,
		"queue": map[string]any{"depth": queue.Depth, "dropped": queue.Dropped}, "spooled": backlog,
		"published": u.counters.published.Load(), "at": time.Now().UTC(),
	})
	u.send(u.prefix+"/agent/heartbeat", 0, false, payload, false)
}

// onCommand handles one command message. It runs on Paho's single handler goroutine and
// never blocks: the write happens in the target PLC's worker.
func (u *Uplink) onCommand(_ mqtt.Client, message mqtt.Message) {
	u.counters.received.Add(1)
	plcID := message.Topic()[strings.LastIndex(message.Topic(), "/")+1:]
	now := time.Now()
	envelope, refusal := command.Parse(message.Payload())
	if envelope.PLCID == "" {
		envelope.PLCID = plcID
	}
	if refusal != nil {
		u.answer(u.rejection(envelope, refusal, now), plcID)
		return
	}
	accepted := command.NewAck(envelope, command.Accepted, now)
	if previous, first := u.commands.Claim(accepted, now); !first {
		// At-least-once delivery: answer again, never write again.
		u.counters.duplicates.Add(1)
		previous.Duplicate, previous.At = true, now.UTC()
		u.answer(previous, plcID)
		return
	}
	var deployment *config.Deployment
	commander, ok := u.source.Commander(plcID)
	if ok {
		deployment = commander.Deployment()
	}
	write, refusal := command.Check(envelope, plcID, deployment, now)
	if refusal != nil {
		ack := u.rejection(envelope, refusal, now)
		u.commands.Update(ack)
		u.answer(ack, plcID)
		return
	}
	u.counters.accepted.Add(1)
	u.answer(accepted, plcID)
	err := commander.Submit(write, func(result worker.Result) {
		ack := command.NewAck(envelope, result.Status, time.Now())
		ack.Rule, ack.Reason, ack.Observed = result.Rule, result.Reason, result.Observed
		if result.Status == command.Applied {
			u.counters.applied.Add(1)
		} else {
			u.counters.failed.Add(1)
		}
		u.commands.Update(ack)
		u.answer(ack, plcID)
		u.log.Info("command done", "plcId", plcID, "commandId", envelope.CommandID, "mapping", write.Mapping.Name,
			"value", fmt.Sprint(write.Value), "status", result.Status, "rule", result.Rule, "requestedBy", envelope.RequestedBy)
	})
	if err != nil {
		// Busy: nothing was written, and the same command may be sent again.
		u.commands.Forget(plcID, envelope.CommandID)
		u.counters.failed.Add(1)
		ack := command.NewAck(envelope, command.Failed, time.Now())
		ack.Rule, ack.Reason = "plc-busy", err.Error()
		u.answer(ack, plcID)
	}
}

func (u *Uplink) rejection(envelope command.Envelope, refusal *command.Refusal, now time.Time) command.Ack {
	u.counters.rejected.Add(1)
	ack := command.NewAck(envelope, command.Rejected, now)
	ack.Rule, ack.Reason = refusal.Rule, refusal.Reason
	u.log.Warn("command refused", "plcId", envelope.PLCID, "commandId", envelope.CommandID, "rule", refusal.Rule, "reason", refusal.Reason)
	return ack
}

func (u *Uplink) answer(ack command.Ack, plcID string) {
	payload, err := json.Marshal(ack)
	if err != nil || !u.send(u.prefix+"/ack/"+plcID, 1, false, payload, false) {
		u.counters.ackErrors.Add(1)
	}
}

// Status is what health shows about the uplink. It never shows a credential.
func (u *Uplink) Status() map[string]any {
	u.mu.Lock()
	lastError := u.lastError
	u.mu.Unlock()
	c := &u.counters
	spooling := map[string]any{"configured": false}
	if u.spool != nil {
		stats := u.spool.Stats()
		spooling = map[string]any{
			"configured": true, "entries": stats.Entries, "bytes": stats.Bytes, "maxBytes": stats.MaxBytes,
			"oldest": stats.Oldest, "written": stats.Written, "replayed": stats.Replayed, "dropped": stats.Dropped,
			"error": stats.Error, "replayRate": u.settings.ReplayRate,
		}
	}
	return map[string]any{
		"spool":           spooling,
		"spooled":         c.spooled.Load(),
		"spoolErrors":     c.spoolErrors.Load(),
		"lost":            c.lost.Load(),
		"replayedOut":     c.replayedOut.Load(),
		"configured":      true,
		"connected":       u.Connected(),
		"broker":          redact(u.settings.BrokerURL),
		"clientId":        u.settings.ClientID,
		"topicRoot":       u.prefix,
		"publishers":      u.settings.Publishers,
		"published":       c.published.Load(),
		"errors":          c.publishErrors.Load(),
		"connects":        c.connects.Load(),
		"lostConnections": c.connectionsLost.Load(),
		"lastError":       lastError,
		"commands": map[string]uint64{
			"received": c.received.Load(), "accepted": c.accepted.Load(), "rejected": c.rejected.Load(),
			"applied": c.applied.Load(), "failed": c.failed.Load(), "duplicates": c.duplicates.Load(),
			"ackErrors": c.ackErrors.Load(),
		},
	}
}

// Stop ends the publishers, says the agent goes offline and disconnects.
func (u *Uplink) Stop() {
	u.cancel()
	u.wg.Wait()
	if u.Connected() {
		u.client.Publish(u.prefix+"/agent/status", 1, true, u.statusPayload("offline")).WaitTimeout(time.Second)
	}
	u.client.Disconnect(500)
	u.log.Info("uplink stopped")
}
