// Package deploy keeps the agent's desired state on disk, in the directories of
// docs/thin-client-agent.md:
//
//	staging/   new and updated deployment files are dropped here (write a temporary
//	           name, then rename: a file is only read once it has a .json name)
//	active/    what runs: one file per PLC, promoted from staging by rename
//	rejected/  refused files, each with a .reason.json saying why
//	spool/     reserved for the offline store-and-forward (TASK-503c)
//
// A scan validates staging files one at a time; a bad file is moved to rejected/ and
// nothing else changes. Removing a file from active/ stops that PLC's worker. The last
// good deployment of a PLC stays in force when its active file later becomes unreadable.
package deploy

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/config"
)

// Directory names under the root.
const (
	Staging  = "staging"
	Active   = "active"
	Rejected = "rejected"
	Spool    = "spool"
)

// keepRejected bounds rejected/: older refusals are deleted beyond this many.
const keepRejected = 200

// Rejection is a refused file, as rejected/ and health report it.
type Rejection struct {
	File    string    `json:"file"`
	PLCID   string    `json:"plcId,omitempty"`
	Rule    string    `json:"rule"`
	Message string    `json:"message"`
	At      time.Time `json:"at"`
}

// Problem is an active file that cannot be used right now; the PLC keeps its last good deployment.
type Problem struct {
	File    string `json:"file"`
	Message string `json:"message"`
}

type activeFile struct {
	deployment *config.Deployment
	modTime    time.Time
	size       int64
}

// Store scans the directories.
type Store struct {
	root   string
	settle time.Duration
	now    func() time.Time

	mu         sync.Mutex
	active     map[string]activeFile // by file name
	rejections []Rejection
	problems   []Problem
	promoted   uint64
}

// Open creates the directories when missing. Files in staging/ younger than settle are
// left for a later scan, as a last guard against a file still being written.
func Open(root string, settle time.Duration) (*Store, error) {
	for _, dir := range []string{Staging, Active, Rejected, Spool} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o750); err != nil {
			return nil, err
		}
	}
	return &Store{root: root, settle: settle, now: time.Now, active: map[string]activeFile{}}, nil
}

// Root returns the directory the store works in.
func (s *Store) Root() string { return s.root }

func (s *Store) path(dir, name string) string { return filepath.Join(s.root, dir, name) }

// candidates lists the .json files of a directory, by name; hidden and temporary files are skipped.
func (s *Store) candidates(dir string) ([]fs.DirEntry, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, dir))
	if err != nil {
		return nil, err
	}
	var files []fs.DirEntry
	for _, entry := range entries {
		name := entry.Name()
		if entry.Type().IsRegular() && strings.HasSuffix(name, ".json") && !strings.HasPrefix(name, ".") &&
			!strings.HasSuffix(name, ".reason.json") {
			files = append(files, entry)
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name() < files[j].Name() })
	return files, nil
}

func read(path string) ([]byte, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if info.Size() > config.MaxFileBytes {
		return nil, info, &config.Error{Rule: "file-size", Message: fmt.Sprintf("the file is larger than %d bytes", config.MaxFileBytes)}
	}
	data := make([]byte, info.Size())
	if _, err := file.ReadAt(data, 0); err != nil && info.Size() > 0 {
		return nil, info, err
	}
	return data, info, nil
}

// Scan loads active/, promotes or rejects what is in staging/, and returns the desired
// deployments by PLC id.
func (s *Store) Scan() (map[string]*config.Deployment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadActive(); err != nil {
		return nil, err
	}
	if err := s.processStaging(); err != nil {
		return s.desired(), err
	}
	return s.desired(), nil
}

// loadActive reads active/ again: a removed file is gone, a changed one is parsed, a broken
// one keeps its last good deployment and is reported.
func (s *Store) loadActive() error {
	files, err := s.candidates(Active)
	if err != nil {
		return err
	}
	s.problems = nil
	present := map[string]bool{}
	for _, entry := range files {
		name := entry.Name()
		present[name] = true
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if known, ok := s.active[name]; ok && known.modTime.Equal(info.ModTime()) && known.size == info.Size() {
			continue
		}
		data, info, err := read(s.path(Active, name))
		if err == nil {
			var deployment *config.Deployment
			deployment, err = config.Parse(data)
			if err == nil {
				s.active[name] = activeFile{deployment: deployment, modTime: info.ModTime(), size: info.Size()}
				continue
			}
		}
		message := err.Error()
		if _, ok := s.active[name]; ok {
			message += "; the last good deployment stays in force"
		}
		s.problems = append(s.problems, Problem{File: name, Message: message})
	}
	for name := range s.active {
		if !present[name] {
			delete(s.active, name)
		}
	}
	// One worker per PLC: a second file for the same PLC is reported and ignored.
	owner := map[string]string{}
	for _, name := range s.sortedActive() {
		plcID := s.active[name].deployment.PLCID
		if first, taken := owner[plcID]; taken {
			s.problems = append(s.problems, Problem{File: name, Message: fmt.Sprintf("PLC %s is already deployed by %s; this file is ignored", plcID, first)})
			continue
		}
		owner[plcID] = name
	}
	return nil
}

func (s *Store) sortedActive() []string {
	names := make([]string, 0, len(s.active))
	for name := range s.active {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (s *Store) desired() map[string]*config.Deployment {
	desired := map[string]*config.Deployment{}
	for _, name := range s.sortedActive() {
		deployment := s.active[name].deployment
		if _, taken := desired[deployment.PLCID]; !taken {
			desired[deployment.PLCID] = deployment
		}
	}
	return desired
}

func (s *Store) processStaging() error {
	files, err := s.candidates(Staging)
	if err != nil {
		return err
	}
	for _, entry := range files {
		name := entry.Name()
		info, err := entry.Info()
		if err != nil || s.now().Sub(info.ModTime()) < s.settle {
			continue
		}
		data, _, err := read(s.path(Staging, name))
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			s.reject(name, "", err)
			continue
		}
		deployment, err := config.Parse(data)
		if err != nil {
			s.reject(name, "", err)
			continue
		}
		if err := s.admit(name, deployment); err != nil {
			s.reject(name, deployment.PLCID, err)
			continue
		}
		if err := s.promote(name, data); err != nil {
			return err
		}
		info, err = os.Stat(s.path(Active, name))
		if err != nil {
			return err
		}
		s.active[name] = activeFile{deployment: deployment, modTime: info.ModTime(), size: info.Size()}
		s.promoted++
	}
	return nil
}

// admit decides whether a valid staging file may replace what runs.
func (s *Store) admit(name string, candidate *config.Deployment) error {
	for _, other := range s.sortedActive() {
		running := s.active[other].deployment
		if other != name && running.PLCID == candidate.PLCID {
			return &config.Error{Rule: "duplicate-plc", Message: fmt.Sprintf("PLC %s is already deployed by %s", candidate.PLCID, other)}
		}
	}
	current, ok := s.active[name]
	if !ok {
		return nil
	}
	running := current.deployment
	switch {
	case running.PLCID != candidate.PLCID:
		return &config.Error{Rule: "file-plc-changed", Message: fmt.Sprintf("%s deploys PLC %s, not %s; remove it from active/ first", name, running.PLCID, candidate.PLCID)}
	case candidate.ConfigVersion < running.ConfigVersion:
		return &config.Error{Rule: "stale-config", Message: fmt.Sprintf("version %d is older than the running version %d", candidate.ConfigVersion, running.ConfigVersion)}
	case candidate.ConfigVersion == running.ConfigVersion && candidate.Checksum != running.Checksum:
		return &config.Error{Rule: "config-version-reused", Message: fmt.Sprintf("version %d already runs with other content", candidate.ConfigVersion)}
	}
	return nil
}

// promote replaces active/<name> atomically and removes the staging file.
func (s *Store) promote(name string, data []byte) error {
	temporary := s.path(Active, "."+name+".tmp")
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary, s.path(Active, name)); err != nil {
		return err
	}
	return os.Remove(s.path(Staging, name))
}

// reject moves a staging file to rejected/ with its reason. Nothing that runs changes.
func (s *Store) reject(name, plcID string, cause error) {
	rule := config.RuleOf(cause)
	if rule == "" {
		rule = "unreadable"
	}
	message := cause.Error()
	var refusal *config.Error
	if errors.As(cause, &refusal) {
		message = refusal.Message
	}
	at := s.now().UTC()
	rejection := Rejection{File: name, PLCID: plcID, Rule: rule, Message: message, At: at}
	stamp := at.Format("20060102T150405.000000000Z")
	base := strings.TrimSuffix(name, ".json") + "." + stamp
	if err := os.Rename(s.path(Staging, name), s.path(Rejected, base+".json")); err == nil {
		if reason, err := json.MarshalIndent(rejection, "", "  "); err == nil {
			_ = os.WriteFile(s.path(Rejected, base+".reason.json"), append(reason, '\n'), 0o640)
		}
	}
	s.rejections = append(s.rejections, rejection)
	if len(s.rejections) > 50 {
		s.rejections = s.rejections[len(s.rejections)-50:]
	}
	s.pruneRejected()
}

func (s *Store) pruneRejected() {
	entries, err := os.ReadDir(filepath.Join(s.root, Rejected))
	if err != nil || len(entries) <= 2*keepRejected {
		return
	}
	// Names carry the time after the file name; delete the oldest pairs by modification time.
	sort.Slice(entries, func(i, j int) bool {
		a, errA := entries[i].Info()
		b, errB := entries[j].Info()
		return errA == nil && errB == nil && a.ModTime().Before(b.ModTime())
	})
	for _, entry := range entries[:len(entries)-2*keepRejected] {
		_ = os.Remove(filepath.Join(s.root, Rejected, entry.Name()))
	}
}

// Report is what health shows about the files.
type Report struct {
	Active     int         `json:"active"`
	Promoted   uint64      `json:"promoted"`
	Rejections []Rejection `json:"rejections"`
	Problems   []Problem   `json:"problems"`
}

// Report returns the files' state.
func (s *Store) Report() Report {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Report{
		Active:     len(s.desired()),
		Promoted:   s.promoted,
		Rejections: append([]Rejection{}, s.rejections...),
		Problems:   append([]Problem{}, s.problems...),
	}
}
