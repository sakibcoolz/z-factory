// Package telemetry carries what the PLC workers read towards the uplink: one batch per
// poll of one PLC, through a bounded queue shared by all workers.
package telemetry

import (
	"context"
	"sync"
	"time"
)

// Qualities a value carries (the same words as Z-Factory's live values).
const (
	Good         = "GOOD"
	Stale        = "STALE"
	Bad          = "BAD"
	Disconnected = "DISCONNECTED"
)

// Value is one mapping's value as read. Value is a float64, a bool, or nil when it was never read.
type Value struct {
	MappingID string    `json:"id"`
	Name      string    `json:"name"`
	Value     any       `json:"value"`
	Quality   string    `json:"quality"`
	At        time.Time `json:"at"`
}

// Batch is one poll of one PLC.
type Batch struct {
	PLCID         string    `json:"plcId"`
	ConfigVersion int64     `json:"configVersion"`
	At            time.Time `json:"at"`
	Values        []Value   `json:"values"`
}

// Queue is a bounded FIFO of batches. When it is full the oldest batch is dropped: a
// newer reading of a PLC is worth more than an older one, and a producer never blocks.
type Queue struct {
	mu       sync.Mutex
	items    []Batch
	head     int
	size     int
	pushed   uint64
	dropped  uint64
	notEmpty chan struct{}
}

// NewQueue returns a queue of at most capacity batches.
func NewQueue(capacity int) *Queue {
	if capacity < 1 {
		capacity = 1
	}
	return &Queue{items: make([]Batch, capacity), notEmpty: make(chan struct{}, 1)}
}

// Push adds a batch without blocking; it reports whether an older batch had to go.
func (q *Queue) Push(batch Batch) (droppedOldest bool) {
	q.mu.Lock()
	if q.size == len(q.items) {
		q.head = (q.head + 1) % len(q.items)
		q.size--
		q.dropped++
		droppedOldest = true
	}
	q.items[(q.head+q.size)%len(q.items)] = batch
	q.size++
	q.pushed++
	q.mu.Unlock()
	select {
	case q.notEmpty <- struct{}{}:
	default:
	}
	return droppedOldest
}

// Pop waits for a batch, or returns false when the context ends.
func (q *Queue) Pop(ctx context.Context) (Batch, bool) {
	for {
		q.mu.Lock()
		if q.size > 0 {
			batch := q.items[q.head]
			q.items[q.head] = Batch{}
			q.head = (q.head + 1) % len(q.items)
			q.size--
			q.mu.Unlock()
			return batch, true
		}
		q.mu.Unlock()
		select {
		case <-ctx.Done():
			return Batch{}, false
		case <-q.notEmpty:
		}
	}
}

// Stats is the queue's depth and counters.
type Stats struct {
	Depth    int    `json:"depth"`
	Capacity int    `json:"capacity"`
	Pushed   uint64 `json:"pushed"`
	Dropped  uint64 `json:"dropped"`
}

// Stats returns the queue's depth and counters.
func (q *Queue) Stats() Stats {
	q.mu.Lock()
	defer q.mu.Unlock()
	return Stats{Depth: q.size, Capacity: len(q.items), Pushed: q.pushed, Dropped: q.dropped}
}
