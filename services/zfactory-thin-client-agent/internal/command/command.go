// Package command checks cloud commands before they reach a PLC and remembers their
// outcome. A command may write one mapping the deployment marks WRITE (a command or
// setpoint tag, ADR-0015), with a value of the right kind in the exported range, for the
// configuration version that runs, before it expires. Everything else is refused.
package command

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sync"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/codec"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
)

// Schemas of the messages.
const (
	Schema    = "zfactory.command"
	AckSchema = "zfactory.command-ack"
	Version   = 1
	// MaxBytes bounds a command message.
	MaxBytes = 16 << 10
	// MaxLifetime bounds how far in the future a command may expire.
	MaxLifetime = 10 * time.Minute
)

// Statuses of an acknowledgement.
const (
	Accepted = "ACCEPTED"
	Rejected = "REJECTED"
	Applied  = "APPLIED"
	Failed   = "FAILED"
)

// Envelope is a command as the cloud sends it.
type Envelope struct {
	Schema        string          `json:"schema"`
	Version       int             `json:"version"`
	CommandID     string          `json:"commandId"`
	PLCID         string          `json:"plcId"`
	MappingID     string          `json:"mappingId"`
	Value         json.RawMessage `json:"value"`
	ConfigVersion int64           `json:"configVersion"`
	IssuedAt      time.Time       `json:"issuedAt"`
	ExpiresAt     time.Time       `json:"expiresAt"`
	RequestedBy   string          `json:"requestedBy,omitempty"`
}

// Ack is what the agent answers about a command.
type Ack struct {
	Schema    string    `json:"schema"`
	Version   int       `json:"version"`
	CommandID string    `json:"commandId"`
	PLCID     string    `json:"plcId"`
	MappingID string    `json:"mappingId,omitempty"`
	Status    string    `json:"status"`
	Rule      string    `json:"rule,omitempty"`
	Reason    string    `json:"reason,omitempty"`
	Observed  any       `json:"observed,omitempty"`
	Duplicate bool      `json:"duplicate,omitempty"`
	At        time.Time `json:"at"`
}

// NewAck returns an acknowledgement of a command.
func NewAck(e Envelope, status string, at time.Time) Ack {
	return Ack{Schema: AckSchema, Version: Version, CommandID: e.CommandID, PLCID: e.PLCID, MappingID: e.MappingID, Status: status, At: at.UTC()}
}

// Refusal is why a command was refused.
type Refusal struct {
	Rule   string
	Reason string
}

func (r *Refusal) Error() string { return r.Rule + ": " + r.Reason }

func refuse(rule, format string, args ...any) *Refusal {
	return &Refusal{Rule: rule, Reason: fmt.Sprintf(format, args...)}
}

// RuleExpired is the rule of a command refused for its deadline: REJECTED when it arrives
// expired, FAILED when it expires while it waits for the PLC (TASK-907). Either way
// nothing is written.
const RuleExpired = "command-expired"

// Write is a checked command: one mapping and the value to put there.
type Write struct {
	CommandID string
	Mapping   config.Mapping
	// ExpiresAt is the command's absolute deadline as the cloud set it. The worker checks
	// it again right before writing: a command that waited past it is never written.
	ExpiresAt time.Time
	// Bool for a coil; Words (already encoded) for registers.
	Bool  bool
	Words []uint16
	// Value is the engineering value, for the record.
	Value any
}

var idPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

// Parse reads a command message strictly. It returns what could be read even when it is
// refused, so the refusal can be acknowledged under the command's id.
func Parse(data []byte) (Envelope, *Refusal) {
	var e Envelope
	if len(data) > MaxBytes {
		return e, refuse("command-size", "the command is larger than %d bytes", MaxBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&e); err != nil {
		// Recover the id if the message is JSON at all, so the sender learns what happened.
		var loose struct {
			CommandID string `json:"commandId"`
		}
		_ = json.Unmarshal(data, &loose)
		e.CommandID = loose.CommandID
		return e, refuse("command-json", "not a valid command: %v", err)
	}
	if e.Schema != Schema || e.Version != Version {
		return e, refuse("command-schema", "expected %s version %d", Schema, Version)
	}
	if !idPattern.MatchString(e.CommandID) {
		return e, refuse("command-id", "commandId must be 1-64 of A-Z a-z 0-9 . _ : -")
	}
	return e, nil
}

// Check decides whether a parsed command may be written to the PLC that runs deployment d.
func Check(e Envelope, topicPLC string, d *config.Deployment, now time.Time) (Write, *Refusal) {
	if e.PLCID != topicPLC {
		return Write{}, refuse("command-plc", "the command names PLC %q but was sent to %q", e.PLCID, topicPLC)
	}
	if d == nil {
		return Write{}, refuse("unknown-plc", "no PLC %q is deployed on this agent", e.PLCID)
	}
	if e.ConfigVersion != d.ConfigVersion {
		return Write{}, refuse("stale-config-version", "the command is for configuration %d, the PLC runs %d", e.ConfigVersion, d.ConfigVersion)
	}
	if e.ExpiresAt.IsZero() || !now.Before(e.ExpiresAt) {
		return Write{}, refuse(RuleExpired, "the command expired or has no expiresAt")
	}
	if e.ExpiresAt.Sub(now) > MaxLifetime {
		return Write{}, refuse("command-expiry", "expiresAt is more than %s ahead", MaxLifetime)
	}
	mapping, ok := d.Mapping(e.MappingID)
	if !ok {
		return Write{}, refuse("unknown-mapping", "PLC %s has no mapping %q", d.PLC.Name, e.MappingID)
	}
	// Only what the export allowed; checked again here against the role and authority.
	if !mapping.Writable() || mapping.Authority != "EXTERNAL_COMMAND" || (mapping.Role != "COMMAND" && mapping.Role != "SETPOINT") {
		return Write{}, refuse("not-writable", "%s is not a command or setpoint tag; the PLC program decides it", mapping.Name)
	}
	write := Write{CommandID: e.CommandID, Mapping: mapping, ExpiresAt: e.ExpiresAt}
	if codec.IsBool(mapping.DataType) {
		var value bool
		if err := json.Unmarshal(e.Value, &value); err != nil {
			return Write{}, refuse("value-type", "%s takes true or false", mapping.Name)
		}
		write.Bool, write.Value = value, value
		return write, nil
	}
	var value float64
	if err := json.Unmarshal(e.Value, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return Write{}, refuse("value-type", "%s takes a number", mapping.Name)
	}
	if mapping.Min == nil || mapping.Max == nil || value < *mapping.Min || value > *mapping.Max {
		return Write{}, refuse("value-range", "%s takes %v to %v", mapping.Name, deref(mapping.Min), deref(mapping.Max))
	}
	words, err := codec.Encode(value, mapping.Encoding())
	if err != nil {
		return Write{}, refuse("value-range", "%s: %v", mapping.Name, err)
	}
	write.Words, write.Value = words, value
	return write, nil
}

func deref(value *float64) any {
	if value == nil {
		return "?"
	}
	return *value
}

// Cache remembers the last acknowledgement of recent commands, so a command delivered
// twice (MQTT QoS 1 is at least once) is answered again but never written twice.
type Cache struct {
	mu      sync.Mutex
	ttl     time.Duration
	limit   int
	entries map[string]cacheEntry
	order   []string
}

type cacheEntry struct {
	ack Ack
	at  time.Time
}

// NewCache keeps at most limit commands for ttl.
func NewCache(limit int, ttl time.Duration) *Cache {
	return &Cache{ttl: ttl, limit: limit, entries: map[string]cacheEntry{}}
}

func key(plcID, commandID string) string { return plcID + "/" + commandID }

// Claim records a command the first time it is seen. It returns the last acknowledgement
// and false when the command was seen before.
func (c *Cache) Claim(ack Ack, now time.Time) (Ack, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.expire(now)
	k := key(ack.PLCID, ack.CommandID)
	if existing, ok := c.entries[k]; ok {
		return existing.ack, false
	}
	c.entries[k] = cacheEntry{ack: ack, at: now}
	c.order = append(c.order, k)
	for len(c.order) > c.limit {
		delete(c.entries, c.order[0])
		c.order = c.order[1:]
	}
	return ack, true
}

// Update records the newest acknowledgement of a claimed command.
func (c *Cache) Update(ack Ack) {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := key(ack.PLCID, ack.CommandID)
	if existing, ok := c.entries[k]; ok {
		existing.ack = ack
		c.entries[k] = existing
	}
}

// Forget drops a command, so that it can be sent again (e.g. it was refused as busy).
func (c *Cache) Forget(plcID, commandID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	k := key(plcID, commandID)
	delete(c.entries, k)
	for i, candidate := range c.order {
		if candidate == k {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
}

func (c *Cache) expire(now time.Time) {
	for len(c.order) > 0 {
		oldest, ok := c.entries[c.order[0]]
		if ok && now.Sub(oldest.at) < c.ttl {
			return
		}
		if ok {
			delete(c.entries, c.order[0])
		}
		c.order = c.order[1:]
	}
}

// Len is how many commands are remembered.
func (c *Cache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// ErrBusy is returned when a PLC's command queue is full.
var ErrBusy = errors.New("the PLC has too many commands waiting")
