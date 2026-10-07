// Package spool keeps telemetry on the edge host while the cloud cannot be reached
// (TASK-503c): an embedded bbolt file under spool/, bounded in bytes and in age, that
// survives a restart of the agent. Oldest entries go first when a bound is reached.
package spool

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	bolt "go.etcd.io/bbolt"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/telemetry"
)

var (
	batches    = []byte("batches")
	meta       = []byte("meta")
	keyBytes   = []byte("bytes")
	keyDropped = []byte("dropped")
)

// Store is what the uplink needs from a spool; the bbolt Spool implements it.
type Store interface {
	Put(batch telemetry.Batch) error
	Peek(limit int) ([]Entry, error)
	Delete(keys []uint64) error
	Stats() Stats
}

// Entry is one spooled batch.
type Entry struct {
	Key   uint64
	Batch telemetry.Batch
}

// Stats is what health shows about the spool.
type Stats struct {
	Entries  int        `json:"entries"`
	Bytes    int64      `json:"bytes"`
	MaxBytes int64      `json:"maxBytes"`
	Oldest   *time.Time `json:"oldest"`
	Written  uint64     `json:"written"`
	Replayed uint64     `json:"replayed"`
	Dropped  uint64     `json:"dropped"`
	Error    string     `json:"error,omitempty"`
}

// Spool is a bbolt file of batches, keyed by a growing sequence.
type Spool struct {
	db       *bolt.DB
	maxBytes int64
	maxAge   time.Duration
	now      func() time.Time

	mu       sync.Mutex
	written  uint64
	replayed uint64
	lastErr  string
}

type record struct {
	SpooledAt time.Time       `json:"spooledAt"`
	Batch     telemetry.Batch `json:"batch"`
}

// Open opens (or creates) the spool file in dir. What an earlier run left is kept.
func Open(dir string, maxBytes int64, maxAge time.Duration) (*Spool, error) {
	if maxBytes <= 0 {
		return nil, errors.New("the spool needs a size limit")
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	db, err := bolt.Open(filepath.Join(dir, "telemetry.db"), 0o640, &bolt.Options{Timeout: 2 * time.Second})
	if err != nil {
		return nil, fmt.Errorf("the spool cannot be opened: %w", err)
	}
	err = db.Update(func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(batches); err != nil {
			return err
		}
		_, err := tx.CreateBucketIfNotExists(meta)
		return err
	})
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Spool{db: db, maxBytes: maxBytes, maxAge: maxAge, now: time.Now}, nil
}

func key(sequence uint64) []byte {
	out := make([]byte, 8)
	binary.BigEndian.PutUint64(out, sequence)
	return out
}

func counter(bucket *bolt.Bucket, name []byte) int64 {
	value := bucket.Get(name)
	if len(value) != 8 {
		return 0
	}
	return int64(binary.BigEndian.Uint64(value))
}

func setCounter(bucket *bolt.Bucket, name []byte, value int64) error {
	return bucket.Put(name, key(uint64(max(value, 0))))
}

func (s *Spool) fail(err error) error {
	if err != nil {
		s.mu.Lock()
		s.lastErr = err.Error()
		s.mu.Unlock()
	}
	return err
}

// Put stores a batch; when the spool is over its size the oldest batches are dropped.
func (s *Spool) Put(batch telemetry.Batch) error {
	value, err := json.Marshal(record{SpooledAt: s.now().UTC(), Batch: batch})
	if err != nil {
		return err
	}
	if int64(len(value)) > s.maxBytes {
		return s.fail(errors.New("a batch is larger than the whole spool"))
	}
	err = s.db.Update(func(tx *bolt.Tx) error {
		data, info := tx.Bucket(batches), tx.Bucket(meta)
		sequence, err := data.NextSequence()
		if err != nil {
			return err
		}
		if err := data.Put(key(sequence), value); err != nil {
			return err
		}
		size := counter(info, keyBytes) + int64(len(value))
		dropped := counter(info, keyDropped)
		cursor := data.Cursor()
		for k, v := cursor.First(); k != nil && size > s.maxBytes; k, v = cursor.First() {
			size -= int64(len(v))
			dropped++
			if err := cursor.Delete(); err != nil {
				return err
			}
		}
		if err := setCounter(info, keyDropped, dropped); err != nil {
			return err
		}
		return setCounter(info, keyBytes, size)
	})
	if err == nil {
		s.mu.Lock()
		s.written++
		s.mu.Unlock()
	}
	return s.fail(err)
}

// Peek returns the oldest batches, at most limit, without removing them.
func (s *Spool) Peek(limit int) ([]Entry, error) {
	var entries []Entry
	err := s.db.View(func(tx *bolt.Tx) error {
		cursor := tx.Bucket(batches).Cursor()
		for k, v := cursor.First(); k != nil && len(entries) < limit; k, v = cursor.Next() {
			var r record
			if err := json.Unmarshal(v, &r); err != nil {
				// An unreadable entry is skipped and removed with the next delete.
				entries = append(entries, Entry{Key: binary.BigEndian.Uint64(k)})
				continue
			}
			entries = append(entries, Entry{Key: binary.BigEndian.Uint64(k), Batch: r.Batch})
		}
		return nil
	})
	return entries, s.fail(err)
}

// Delete removes batches that reached the cloud.
func (s *Spool) Delete(keys []uint64) error {
	err := s.db.Update(func(tx *bolt.Tx) error {
		data, info := tx.Bucket(batches), tx.Bucket(meta)
		size := counter(info, keyBytes)
		for _, k := range keys {
			if v := data.Get(key(k)); v != nil {
				size -= int64(len(v))
				if err := data.Delete(key(k)); err != nil {
					return err
				}
			}
		}
		return setCounter(info, keyBytes, size)
	})
	if err == nil {
		s.mu.Lock()
		s.replayed += uint64(len(keys))
		s.mu.Unlock()
	}
	return s.fail(err)
}

// Prune drops batches older than the spool's age limit and returns how many.
func (s *Spool) Prune() (int, error) {
	if s.maxAge <= 0 {
		return 0, nil
	}
	cutoff := s.now().Add(-s.maxAge)
	pruned := 0
	err := s.db.Update(func(tx *bolt.Tx) error {
		data, info := tx.Bucket(batches), tx.Bucket(meta)
		size, dropped := counter(info, keyBytes), counter(info, keyDropped)
		cursor := data.Cursor()
		for k, v := cursor.First(); k != nil; k, v = cursor.First() {
			var r record
			if json.Unmarshal(v, &r) == nil && r.SpooledAt.After(cutoff) {
				break
			}
			size -= int64(len(v))
			dropped++
			pruned++
			if err := cursor.Delete(); err != nil {
				return err
			}
		}
		if err := setCounter(info, keyDropped, dropped); err != nil {
			return err
		}
		return setCounter(info, keyBytes, size)
	})
	return pruned, s.fail(err)
}

// Stats returns the spool's state.
func (s *Spool) Stats() Stats {
	s.mu.Lock()
	stats := Stats{MaxBytes: s.maxBytes, Written: s.written, Replayed: s.replayed, Error: s.lastErr}
	s.mu.Unlock()
	_ = s.db.View(func(tx *bolt.Tx) error {
		data, info := tx.Bucket(batches), tx.Bucket(meta)
		stats.Entries = data.Stats().KeyN
		stats.Bytes = counter(info, keyBytes)
		stats.Dropped = uint64(counter(info, keyDropped))
		if _, v := data.Cursor().First(); v != nil {
			var r record
			if json.Unmarshal(v, &r) == nil {
				oldest := r.SpooledAt
				stats.Oldest = &oldest
			}
		}
		return nil
	})
	return stats
}

// Close closes the file; what is in it stays for the next run.
func (s *Spool) Close() error { return s.db.Close() }
