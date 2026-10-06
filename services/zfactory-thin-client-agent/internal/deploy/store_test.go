package deploy_test

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/deploy"
	"github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent/internal/testkit"
)

func open(t *testing.T) (*deploy.Store, string) {
	t.Helper()
	root := t.TempDir()
	store, err := deploy.Open(root, 0)
	if err != nil {
		t.Fatal(err)
	}
	return store, root
}

// stage writes a file the way the deployment tooling must: a temporary name, then rename.
func stage(t *testing.T, root, name string, data []byte) {
	t.Helper()
	temporary := filepath.Join(root, deploy.Staging, "."+name+".tmp")
	if err := os.WriteFile(temporary, data, 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, filepath.Join(root, deploy.Staging, name)); err != nil {
		t.Fatal(err)
	}
}

func list(t *testing.T, root, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(root, dir))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func file(id string, version int64) []byte {
	return testkit.File(id, strings.ToUpper(id), "127.0.0.1", 502, testkit.Options{Version: version})
}

func scan(t *testing.T, store *deploy.Store) map[string]int64 {
	t.Helper()
	desired, err := store.Scan()
	if err != nil {
		t.Fatal(err)
	}
	versions := map[string]int64{}
	for id, deployment := range desired {
		versions[id] = deployment.ConfigVersion
	}
	return versions
}

func TestPromotesValidFilesAndKeepsTheRestRunning(t *testing.T) {
	store, root := open(t)
	if got := scan(t, store); len(got) != 0 {
		t.Fatalf("no files, no PLCs: %v", got)
	}
	stage(t, root, "plc-a.json", file("plc-a", 1))
	stage(t, root, "plc-b.json", file("plc-b", 1))
	if got := scan(t, store); len(got) != 2 || got["plc-a"] != 1 {
		t.Fatalf("two PLCs: %v", got)
	}
	if got := list(t, root, deploy.Staging); len(got) != 0 {
		t.Fatalf("staging should be empty: %v", got)
	}
	if got := list(t, root, deploy.Active); strings.Join(got, ",") != "plc-a.json,plc-b.json" {
		t.Fatalf("active: %v", got)
	}

	// An update of one PLC replaces only that one.
	stage(t, root, "plc-a.json", file("plc-a", 2))
	if got := scan(t, store); got["plc-a"] != 2 || got["plc-b"] != 1 {
		t.Fatalf("update: %v", got)
	}

	// Removing an active file stops that PLC only.
	if err := os.Remove(filepath.Join(root, deploy.Active, "plc-b.json")); err != nil {
		t.Fatal(err)
	}
	if got := scan(t, store); len(got) != 1 || got["plc-a"] != 2 {
		t.Fatalf("remove: %v", got)
	}
}

func TestRejectsBadCandidatesInIsolation(t *testing.T) {
	store, root := open(t)
	stage(t, root, "plc-a.json", file("plc-a", 3))
	scan(t, store)

	stage(t, root, "broken.json", []byte(`{"schema": "zfactory.edge-deployment", "sche`))
	stage(t, root, "changed.json", testkit.File("plc-c", "PLC-C", "127.0.0.1", 502, testkit.Options{Corrupt: true}))
	stage(t, root, "copy-of-a.json", file("plc-a", 9))
	got := scan(t, store)
	if len(got) != 1 || got["plc-a"] != 3 {
		t.Fatalf("the running PLC is untouched: %v", got)
	}
	// An older or a reused version never replaces what runs.
	stage(t, root, "plc-a.json", file("plc-a", 2))
	scan(t, store)
	stage(t, root, "plc-a.json", testkit.File("plc-a", "PLC-A", "127.0.0.1", 503, testkit.Options{Version: 3}))
	scan(t, store)
	// A file name that deploys another PLC is refused too.
	stage(t, root, "plc-a.json", file("plc-z", 4))
	if got := scan(t, store); len(got) != 1 || got["plc-a"] != 3 {
		t.Fatalf("still the last good deployment: %v", got)
	}

	rules := map[string]string{}
	for _, rejection := range store.Report().Rejections {
		rules[rejection.File+"#"+rejection.Rule] = rejection.Message
	}
	for _, want := range []string{
		"broken.json#json",
		"changed.json#checksum",
		"copy-of-a.json#duplicate-plc",
		"plc-a.json#stale-config",
		"plc-a.json#config-version-reused",
		"plc-a.json#file-plc-changed",
	} {
		if _, ok := rules[want]; !ok {
			t.Errorf("missing rejection %s in %v", want, rules)
		}
	}
	rejected := list(t, root, deploy.Rejected)
	if len(rejected) != 12 {
		t.Fatalf("each refusal keeps the file and its reason: %v", rejected)
	}
	reason, err := os.ReadFile(filepath.Join(root, deploy.Rejected, rejected[1]))
	if err != nil || !strings.Contains(string(reason), `"rule"`) {
		t.Fatalf("reason file: %s %v", reason, err)
	}
	if got := list(t, root, deploy.Staging); len(got) != 0 {
		t.Fatalf("staging should be empty: %v", got)
	}
}

func TestNeverReadsAFileThatIsStillBeingWritten(t *testing.T) {
	root := t.TempDir()
	store, err := deploy.Open(root, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// A temporary name is never a candidate, and a fresh .json waits for the settle time.
	if err := os.WriteFile(filepath.Join(root, deploy.Staging, ".plc-a.json.tmp"), []byte("{"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, deploy.Staging, "plc-a.json"), []byte(`{"half`), 0o640); err != nil {
		t.Fatal(err)
	}
	if got := scan(t, store); len(got) != 0 {
		t.Fatalf("nothing is loaded: %v", got)
	}
	if got := list(t, root, deploy.Rejected); len(got) != 0 {
		t.Fatalf("nothing is rejected yet: %v", got)
	}
}

func TestKeepsTheLastGoodDeploymentWhenTheActiveFileBreaks(t *testing.T) {
	store, root := open(t)
	stage(t, root, "plc-a.json", file("plc-a", 1))
	scan(t, store)
	path := filepath.Join(root, deploy.Active, "plc-a.json")
	if err := os.WriteFile(path, []byte("garbage"), 0o640); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(2 * time.Second)
	_ = os.Chtimes(path, later, later)
	if got := scan(t, store); got["plc-a"] != 1 {
		t.Fatalf("last good deployment: %v", got)
	}
	problems := store.Report().Problems
	if len(problems) != 1 || !strings.Contains(problems[0].Message, "last good deployment stays in force") {
		t.Fatalf("problem reported: %+v", problems)
	}

	// A second active file for the same PLC is ignored and reported.
	if err := os.WriteFile(filepath.Join(root, deploy.Active, "zz-copy.json"), file("plc-a", 5), 0o640); err != nil {
		t.Fatal(err)
	}
	if got := scan(t, store); got["plc-a"] != 1 || len(got) != 1 {
		t.Fatalf("still one PLC: %v", got)
	}
	if len(store.Report().Problems) != 2 {
		t.Fatalf("problems: %+v", store.Report().Problems)
	}
}
