package spool_test

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/spool"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/telemetry"
)

func batch(plcID string, n int) telemetry.Batch {
	return telemetry.Batch{PLCID: plcID, ConfigVersion: 1, At: time.Unix(int64(n), 0).UTC(), Values: []telemetry.Value{
		{MappingID: "m", Name: "Speed", Value: float64(n), Quality: telemetry.Good},
	}}
}

func TestKeepsBatchesInOrderAcrossARestart(t *testing.T) {
	dir := t.TempDir()
	s, err := spool.Open(dir, 1<<20, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	for n := range 5 {
		if err := s.Put(batch("plc-1", n)); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := s.Peek(3)
	if err != nil || len(entries) != 3 || entries[0].Batch.Values[0].Value != 0.0 || entries[2].Batch.Values[0].Value != 2.0 {
		t.Fatalf("oldest first: %+v %v", entries, err)
	}
	if err := s.Delete([]uint64{entries[0].Key, entries[1].Key}); err != nil {
		t.Fatal(err)
	}
	before := s.Stats()
	if before.Entries != 3 || before.Written != 5 || before.Replayed != 2 || before.Bytes <= 0 {
		t.Fatalf("stats %+v", before)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	// The next run finds what was left, in the same order, and keeps numbering after it.
	again, err := spool.Open(dir, 1<<20, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = again.Close() }()
	if stats := again.Stats(); stats.Entries != 3 || stats.Bytes != before.Bytes {
		t.Fatalf("after restart %+v", stats)
	}
	if err := again.Put(batch("plc-1", 9)); err != nil {
		t.Fatal(err)
	}
	entries, _ = again.Peek(10)
	values := []any{}
	for _, entry := range entries {
		values = append(values, entry.Batch.Values[0].Value)
	}
	if len(values) != 4 || values[0] != 2.0 || values[3] != 9.0 {
		t.Fatalf("order after restart %v", values)
	}
}

func TestStaysWithinItsSizeAndAge(t *testing.T) {
	s, err := spool.Open(t.TempDir(), 2000, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	for n := range 100 {
		if err := s.Put(batch("plc-1", n)); err != nil {
			t.Fatal(err)
		}
	}
	stats := s.Stats()
	if stats.Bytes > 2000 || stats.Dropped == 0 || stats.Entries+int(stats.Dropped) != 100 {
		t.Fatalf("bounded: %+v", stats)
	}
	entries, _ := s.Peek(1)
	if entries[0].Batch.Values[0].Value == 0.0 {
		t.Fatal("the oldest batches go first")
	}

	old, err := spool.Open(t.TempDir(), 1<<20, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = old.Close() }()
	for n := range 3 {
		_ = old.Put(batch("plc-1", n))
	}
	time.Sleep(10 * time.Millisecond)
	if pruned, err := old.Prune(); err != nil || pruned != 3 || old.Stats().Entries != 0 {
		t.Fatalf("pruned %d %v %+v", pruned, err, old.Stats())
	}
}

func TestRefusesAFileItCannotUse(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "telemetry.db"), []byte("not a bolt file"), 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := spool.Open(dir, 1<<20, time.Hour); err == nil {
		t.Fatal("a broken spool file is reported, not used")
	}
	if _, err := spool.Open(t.TempDir(), 0, time.Hour); err == nil {
		t.Fatal("a spool needs a size limit")
	}
}
