// Package testkit builds deployment files for tests, the way Z-Factory exports them.
package testkit

import (
	"encoding/json"
	"fmt"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
)

func ptr[T any](value T) *T { return &value }

// Read is a READ mapping.
func Read(id, name, dataType, area string, address int, scale float64) config.Mapping {
	words := 1
	if dataType == "INT32" || dataType == "UINT32" || dataType == "FLOAT32" {
		words = 2
	}
	return config.Mapping{
		ID: id, Name: name, Access: "READ", Role: "STATUS", Authority: "PROGRAM_OUTPUT", DataType: dataType,
		Area: area, Address: address, WordCount: words, ByteOrder: "BIG_ENDIAN", WordOrder: "HIGH_WORD_FIRST",
		Scale: scale, Offset: 0,
	}
}

// Command is a writable setpoint or command mapping.
func Command(id, name, dataType, area string, address int, scale float64) config.Mapping {
	m := Read(id, name, dataType, area, address, scale)
	m.Access, m.Authority, m.Role = "WRITE", "EXTERNAL_COMMAND", "SETPOINT"
	if dataType == "BOOL" {
		m.Role = "COMMAND"
	} else {
		m.Min, m.Max = ptr(-3276.8), ptr(3276.7)
	}
	return m
}

// Mappings is a small PLC: a run command, a speed setpoint, a running bit and an actual speed.
func Mappings() []config.Mapping {
	return []config.Mapping{
		Command("m-start", "Start_Cmd", "BOOL", "COIL", 800, 1),
		Command("m-speed", "Speed_SP", "INT16", "HOLDING_REGISTER", 100, 0.1),
		Read("m-running", "Running", "BOOL", "COIL", 8192, 1),
		Read("m-actual", "Actual_Hz", "INT16", "HOLDING_REGISTER", 1024, 0.1),
		Read("m-pressure", "Pressure", "FLOAT32", "HOLDING_REGISTER", 2048, 1),
	}
}

// Options vary a deployment.
type Options struct {
	Version  int64
	PollMs   int
	Mappings []config.Mapping
	// Corrupt changes the body after the checksum was computed.
	Corrupt bool
	Indent  bool
}

// File returns the bytes of a deployment file for one PLC.
func File(plcID, name, host string, port int, options Options) []byte {
	if options.Version == 0 {
		options.Version = 1
	}
	if options.PollMs == 0 {
		options.PollMs = 100
	}
	if options.Mappings == nil {
		options.Mappings = Mappings()
	}
	body := config.Body{
		Site: config.Site{FactoryID: "factory-1", FactoryName: "Test Factory", FactorySlug: "test-factory"},
		PLC:  config.PLC{PLCID: plcID, Name: name},
		Connection: config.Connection{
			Protocol: "MODBUS_TCP", Host: host, Port: port, UnitID: 1, TimeoutMs: 500, PollIntervalMs: options.PollMs,
		},
		Modules:  []config.Module{},
		Mappings: options.Mappings,
	}
	raw, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}
	checksum, err := config.Checksum(raw)
	if err != nil {
		panic(err)
	}
	if options.Corrupt {
		body.Connection.Port++
		raw, _ = json.Marshal(body)
	}
	document := config.Document{
		Schema: config.Schema, SchemaVersion: config.SchemaVersion, ConfigVersion: options.Version, PLCID: plcID,
		GeneratedAt: "2026-10-07T00:00:00.000Z", Checksum: checksum, Deployment: raw,
	}
	var data []byte
	if options.Indent {
		data, err = json.MarshalIndent(document, "", "  ")
	} else {
		data, err = json.Marshal(document)
	}
	if err != nil {
		panic(fmt.Sprintf("testkit: %v", err))
	}
	return data
}
