// Package config parses and validates the edge deployment of one PLC: the file Z-Factory
// exports (lib/domain/edge-deployment.ts) and the agent's only source of desired state.
// A file is accepted whole or not at all; nothing in it is trusted before it is checked.
package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/codec"
)

// Schema and SchemaVersion name the file format this agent understands.
const (
	Schema        = "zfactory.edge-deployment"
	SchemaVersion = 1
	// MaxFileBytes bounds what the agent reads from one file.
	MaxFileBytes = 8 << 20
	MaxMappings  = 5000
)

// Limits on timing, the same as Z-Factory's export (EDGE_LIMITS).
const (
	MinPollMs    = 100
	MaxPollMs    = 3_600_000
	MinTimeoutMs = 100
	MaxTimeoutMs = 60_000
)

// Document is the file as exported.
type Document struct {
	Schema        string          `json:"schema"`
	SchemaVersion int             `json:"schemaVersion"`
	ConfigVersion int64           `json:"configVersion"`
	PLCID         string          `json:"plcId"`
	GeneratedAt   string          `json:"generatedAt"`
	Checksum      string          `json:"checksum"`
	Deployment    json.RawMessage `json:"deployment"`
}

// Site identifies the factory the PLC belongs to.
type Site struct {
	FactoryID   string `json:"factoryId"`
	FactoryName string `json:"factoryName"`
	FactorySlug string `json:"factorySlug"`
}

// PLC identifies the PLC.
type PLC struct {
	PLCID string  `json:"plcId"`
	Name  string  `json:"name"`
	Role  *string `json:"role"`
}

// Connection is how the agent reaches the PLC.
type Connection struct {
	Protocol       string `json:"protocol"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	UnitID         int    `json:"unitId"`
	TimeoutMs      int    `json:"timeoutMs"`
	PollIntervalMs int    `json:"pollIntervalMs"`
}

// Module is a process module the PLC carries signals of.
type Module struct {
	ModuleID string `json:"moduleId"`
	Name     string `json:"name"`
	Type     string `json:"type"`
}

// Mapping is one tag of the PLC: read always, written on a cloud command only when WRITE.
type Mapping struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Access         string   `json:"access"`
	Role           string   `json:"role"`
	Authority      string   `json:"authority"`
	DataType       string   `json:"dataType"`
	Area           string   `json:"area"`
	Address        int      `json:"address"`
	WordCount      int      `json:"wordCount"`
	ByteOrder      string   `json:"byteOrder"`
	WordOrder      string   `json:"wordOrder"`
	Scale          float64  `json:"scale"`
	Offset         float64  `json:"offset"`
	Unit           *string  `json:"unit"`
	Min            *float64 `json:"min,omitempty"`
	Max            *float64 `json:"max,omitempty"`
	ProgramAddress *string  `json:"programAddress"`
}

// Encoding is the mapping's codec encoding.
func (m Mapping) Encoding() codec.Encoding {
	return codec.Encoding{DataType: m.DataType, ByteOrder: m.ByteOrder, WordOrder: m.WordOrder, Scale: m.Scale, Offset: m.Offset}
}

// Writable reports whether a cloud command may write the mapping.
func (m Mapping) Writable() bool { return m.Access == "WRITE" }

// Body is the checked content of the deployment.
type Body struct {
	Site       Site       `json:"site"`
	PLC        PLC        `json:"plc"`
	Connection Connection `json:"connection"`
	Modules    []Module   `json:"modules"`
	Mappings   []Mapping  `json:"mappings"`
}

// Deployment is a file that passed every check.
type Deployment struct {
	ConfigVersion int64
	PLCID         string
	Checksum      string
	GeneratedAt   string
	Body
}

// Mapping returns the mapping with the id.
func (d *Deployment) Mapping(id string) (Mapping, bool) {
	for _, mapping := range d.Mappings {
		if mapping.ID == id {
			return mapping, true
		}
	}
	return Mapping{}, false
}

// Error is why a file was refused; Rule names the check for the record.
type Error struct {
	Rule    string
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Rule, e.Message) }

func refuse(rule, format string, args ...any) error {
	return &Error{Rule: rule, Message: fmt.Sprintf(format, args...)}
}

// RuleOf returns the rule of a config error, or "" for another error.
func RuleOf(err error) string {
	var refusal *Error
	if errors.As(err, &refusal) {
		return refusal.Rule
	}
	return ""
}

var (
	hostPattern     = regexp.MustCompile(`^[A-Za-z0-9.:-]{1,253}$`)
	checksumPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	areas           = map[string]bool{"COIL": true, "DISCRETE_INPUT": true, "HOLDING_REGISTER": true, "INPUT_REGISTER": true}
)

func strict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("trailing data after the JSON value")
	}
	return nil
}

// Checksum is `sha256:` + the hex digest of the compact JSON text of a deployment body.
func Checksum(raw json.RawMessage) (string, error) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return "", err
	}
	sum := sha256.Sum256(compact.Bytes())
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// Parse checks a file and returns its deployment, or the first rule it breaks.
func Parse(data []byte) (*Deployment, error) {
	if len(data) > MaxFileBytes {
		return nil, refuse("file-size", "the file is larger than %d bytes", MaxFileBytes)
	}
	var document Document
	if err := strict(data, &document); err != nil {
		return nil, refuse("json", "not a valid deployment file: %v", err)
	}
	if document.Schema != Schema {
		return nil, refuse("schema", "schema is %q, expected %q", document.Schema, Schema)
	}
	if document.SchemaVersion != SchemaVersion {
		return nil, refuse("schema-version", "schema version %d is not supported (this agent reads %d)", document.SchemaVersion, SchemaVersion)
	}
	if document.ConfigVersion < 1 {
		return nil, refuse("config-version", "configVersion must be 1 or more")
	}
	if document.PLCID == "" || len(document.PLCID) > 64 {
		return nil, refuse("plc-id", "plcId is missing or too long")
	}
	if !checksumPattern.MatchString(document.Checksum) {
		return nil, refuse("checksum", "checksum must be sha256: followed by 64 hex digits")
	}
	if len(document.Deployment) == 0 {
		return nil, refuse("json", "the deployment is missing")
	}
	sum, err := Checksum(document.Deployment)
	if err != nil {
		return nil, refuse("json", "the deployment is not valid JSON: %v", err)
	}
	if sum != document.Checksum {
		return nil, refuse("checksum", "the deployment does not match its checksum; the file was changed or cut short")
	}
	var body Body
	if err := strict(document.Deployment, &body); err != nil {
		return nil, refuse("json", "the deployment does not have the expected shape: %v", err)
	}
	deployment := &Deployment{
		ConfigVersion: document.ConfigVersion,
		PLCID:         document.PLCID,
		Checksum:      document.Checksum,
		GeneratedAt:   document.GeneratedAt,
		Body:          body,
	}
	if err := validate(deployment); err != nil {
		return nil, err
	}
	return deployment, nil
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }

func validate(d *Deployment) error {
	if d.PLC.PLCID != d.PLCID {
		return refuse("plc-id", "the deployment is for PLC %q but the file names %q", d.PLC.PLCID, d.PLCID)
	}
	if d.PLC.Name == "" {
		return refuse("plc-name", "the PLC has no name")
	}
	c := d.Connection
	switch {
	case c.Protocol != "MODBUS_TCP":
		return refuse("protocol", "protocol %q is not supported (MODBUS_TCP)", c.Protocol)
	case !hostPattern.MatchString(c.Host):
		return refuse("host", "host %q is not a host name or IP address", c.Host)
	case c.Port < 1 || c.Port > 65535:
		return refuse("port", "port %d is outside 1-65535", c.Port)
	case c.UnitID < 0 || c.UnitID > 255:
		return refuse("unit-id", "unit id %d is outside 0-255", c.UnitID)
	case c.TimeoutMs < MinTimeoutMs || c.TimeoutMs > MaxTimeoutMs:
		return refuse("timeout", "timeoutMs %d is outside %d-%d", c.TimeoutMs, MinTimeoutMs, MaxTimeoutMs)
	case c.PollIntervalMs < MinPollMs || c.PollIntervalMs > MaxPollMs:
		return refuse("poll-interval", "pollIntervalMs %d is outside %d-%d", c.PollIntervalMs, MinPollMs, MaxPollMs)
	}
	if len(d.Mappings) > MaxMappings {
		return refuse("mapping-count", "%d mappings, at most %d", len(d.Mappings), MaxMappings)
	}
	ids := map[string]bool{}
	names := map[string]bool{}
	for index, m := range d.Mappings {
		where := fmt.Sprintf("mapping %d (%s)", index+1, m.Name)
		if m.ID == "" || ids[m.ID] {
			return refuse("mapping-id", "%s: the id is missing or used twice", where)
		}
		if m.Name == "" || names[m.Name] {
			return refuse("mapping-name", "%s: the name is missing or used twice", where)
		}
		ids[m.ID], names[m.Name] = true, true
		if !codec.Known(m.DataType) {
			return refuse("mapping-type", "%s: data type %q is not supported", where, m.DataType)
		}
		if !areas[m.Area] {
			return refuse("mapping-area", "%s: area %q is not a Modbus area", where, m.Area)
		}
		bitArea := m.Area == "COIL" || m.Area == "DISCRETE_INPUT"
		if codec.IsBool(m.DataType) != bitArea {
			return refuse("mapping-area", "%s: %s cannot sit in %s", where, m.DataType, m.Area)
		}
		if m.WordCount != codec.Words(m.DataType) {
			return refuse("mapping-width", "%s: %s takes %d word(s), the file says %d", where, m.DataType, codec.Words(m.DataType), m.WordCount)
		}
		if m.Address < 0 || m.Address+m.WordCount > 65536 {
			return refuse("mapping-address", "%s: address %d is outside the Modbus address space", where, m.Address)
		}
		if m.ByteOrder != "BIG_ENDIAN" && m.ByteOrder != "LITTLE_ENDIAN" {
			return refuse("mapping-order", "%s: byte order %q is unknown", where, m.ByteOrder)
		}
		if m.WordOrder != "HIGH_WORD_FIRST" && m.WordOrder != "LOW_WORD_FIRST" {
			return refuse("mapping-order", "%s: word order %q is unknown", where, m.WordOrder)
		}
		if !finite(m.Scale) || m.Scale == 0 || !finite(m.Offset) {
			return refuse("mapping-scale", "%s: scale must be a non-zero number and offset a number", where)
		}
		switch m.Access {
		case "READ":
		case "WRITE":
			// The cloud may write command and setpoint memory only (ADR-0015): never an
			// output, an input, feedback or a read-only area.
			if m.Authority != "EXTERNAL_COMMAND" || (m.Role != "COMMAND" && m.Role != "SETPOINT") {
				return refuse("mapping-write", "%s: only command and setpoint tags can be writable, not %s %s", where, m.Role, m.Authority)
			}
			if m.Area != "COIL" && m.Area != "HOLDING_REGISTER" {
				return refuse("mapping-write", "%s: %s cannot be written over Modbus", where, m.Area)
			}
			if !codec.IsBool(m.DataType) {
				if m.Min == nil || m.Max == nil || !finite(*m.Min) || !finite(*m.Max) || *m.Min > *m.Max {
					return refuse("mapping-range", "%s: a writable number needs a range min <= max", where)
				}
			}
		default:
			return refuse("mapping-access", "%s: access %q is not READ or WRITE", where, m.Access)
		}
	}
	return nil
}
