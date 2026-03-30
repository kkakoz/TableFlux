package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

type DataStore struct {
	mu        sync.Mutex
	configDir string
	statePath string
	vaultPath string
	state     appState
	vault     vaultState
}

func NewDataStore(appName string) (*DataStore, error) {
	cfgDir, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	baseDir := filepath.Join(cfgDir, appName)
	if err := os.MkdirAll(baseDir, 0o700); err != nil {
		return nil, err
	}

	ds := &DataStore{
		configDir: baseDir,
		statePath: filepath.Join(baseDir, "state.json"),
		vaultPath: filepath.Join(baseDir, "vault.json"),
		state: appState{
			Groups:      []WorkspaceGroup{},
			Connections: []ConnectionMeta{},
			Sessions:    map[string]StudioSessionSnapshot{},
			Tasks:       []BackgroundTask{},
		},
		vault: vaultState{Secrets: map[string]string{}},
	}
	if err := ds.load(); err != nil {
		return nil, err
	}
	if len(ds.state.Groups) == 0 {
		now := time.Now()
		ds.state.Groups = append(ds.state.Groups, WorkspaceGroup{
			ID:        uuid.NewString(),
			Name:      "Default Group",
			Color:     "#0f766e",
			Icon:      "database",
			Order:     0,
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err := ds.saveStateLocked(); err != nil {
			return nil, err
		}
	}
	return ds, nil
}

func (ds *DataStore) load() error {
	ds.mu.Lock()
	defer ds.mu.Unlock()

	if err := loadJSONFile(ds.statePath, &ds.state); err != nil {
		return err
	}
	if ds.state.Sessions == nil {
		ds.state.Sessions = map[string]StudioSessionSnapshot{}
	}
	if ds.state.Tasks == nil {
		ds.state.Tasks = []BackgroundTask{}
	}
	if err := loadJSONFile(ds.vaultPath, &ds.vault); err != nil {
		return err
	}
	if ds.vault.Secrets == nil {
		ds.vault.Secrets = map[string]string{}
	}
	return nil
}

func loadJSONFile(path string, target any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if len(b) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, target); err != nil {
		return fmt.Errorf("failed to parse %s: %w", path, err)
	}
	return nil
}

func (ds *DataStore) saveStateLocked() error {
	return writeJSONAtomic(ds.statePath, ds.state)
}

func (ds *DataStore) saveVaultLocked() error {
	return writeJSONAtomic(ds.vaultPath, ds.vault)
}

func writeJSONAtomic(path string, data any) error {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (ds *DataStore) ListGroups() []WorkspaceGroup {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	out := make([]WorkspaceGroup, len(ds.state.Groups))
	copy(out, ds.state.Groups)
	return out
}

func (ds *DataStore) GetGroup(groupID string) (WorkspaceGroup, bool) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	for _, g := range ds.state.Groups {
		if g.ID == groupID {
			return g, true
		}
	}
	return WorkspaceGroup{}, false
}

func (ds *DataStore) CreateGroup(req GroupCreateRequest) (WorkspaceGroup, error) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	now := time.Now()
	g := WorkspaceGroup{
		ID:        uuid.NewString(),
		Name:      fallback(req.Name, "Untitled Group"),
		Color:     fallback(req.Color, "#0f766e"),
		Icon:      fallback(req.Icon, "database"),
		Order:     len(ds.state.Groups),
		CreatedAt: now,
		UpdatedAt: now,
	}
	ds.state.Groups = append(ds.state.Groups, g)
	return g, ds.saveStateLocked()
}

func (ds *DataStore) UpdateGroup(groupID string, req GroupUpdateRequest) (WorkspaceGroup, error) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	for i := range ds.state.Groups {
		if ds.state.Groups[i].ID != groupID {
			continue
		}
		if req.Name != "" {
			ds.state.Groups[i].Name = req.Name
		}
		if req.Color != "" {
			ds.state.Groups[i].Color = req.Color
		}
		if req.Icon != "" {
			ds.state.Groups[i].Icon = req.Icon
		}
		ds.state.Groups[i].UpdatedAt = time.Now()
		return ds.state.Groups[i], ds.saveStateLocked()
	}
	return WorkspaceGroup{}, errors.New("group not found")
}

func (ds *DataStore) ReorderGroups(ids []string) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if len(ids) != len(ds.state.Groups) {
		return errors.New("orderedIds length mismatch")
	}
	idx := map[string]WorkspaceGroup{}
	for _, g := range ds.state.Groups {
		idx[g.ID] = g
	}
	next := make([]WorkspaceGroup, 0, len(ids))
	for i, id := range ids {
		g, ok := idx[id]
		if !ok {
			return fmt.Errorf("unknown group id: %s", id)
		}
		g.Order = i
		g.UpdatedAt = time.Now()
		next = append(next, g)
	}
	ds.state.Groups = next
	return ds.saveStateLocked()
}

func (ds *DataStore) DeleteGroup(groupID string) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	groups := make([]WorkspaceGroup, 0, len(ds.state.Groups))
	for _, g := range ds.state.Groups {
		if g.ID != groupID {
			groups = append(groups, g)
		}
	}
	if len(groups) == len(ds.state.Groups) {
		return errors.New("group not found")
	}
	for i := range groups {
		groups[i].Order = i
	}
	conns := make([]ConnectionMeta, 0, len(ds.state.Connections))
	for _, c := range ds.state.Connections {
		if c.GroupID != groupID {
			conns = append(conns, c)
		} else {
			delete(ds.vault.Secrets, c.ID)
		}
	}
	delete(ds.state.Sessions, groupID)
	ds.state.Groups = groups
	ds.state.Connections = conns
	if err := ds.saveStateLocked(); err != nil {
		return err
	}
	return ds.saveVaultLocked()
}

func (ds *DataStore) ListConnections(groupID string) []ConnectionMeta {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	out := make([]ConnectionMeta, 0, len(ds.state.Connections))
	for _, c := range ds.state.Connections {
		if groupID == "" || c.GroupID == groupID {
			out = append(out, c)
		}
	}
	return out
}

func (ds *DataStore) GetConnection(connectionID string) (ConnectionMeta, bool) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	for _, c := range ds.state.Connections {
		if c.ID == connectionID {
			return c, true
		}
	}
	return ConnectionMeta{}, false
}

func (ds *DataStore) PutConnection(connectionID string, req ConnectionUpsertRequest) (ConnectionMeta, bool, error) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	now := time.Now()
	if connectionID != "" {
		for i := range ds.state.Connections {
			if ds.state.Connections[i].ID != connectionID {
				continue
			}
			c := ds.state.Connections[i]
			c.GroupID = req.GroupID
			c.Name = req.Name
			c.Driver = normalizeDriver(req.Driver)
			c.Host = req.Host
			c.Port = req.Port
			c.User = req.User
			c.DefaultDB = req.DefaultDB
			c.SSLMode = fallback(req.SSLMode, "disable")
			c.SSHTunnel = req.SSHTunnel
			c.Tags = req.Tags
			c.ReadOnlyFlag = req.ReadOnlyFlag
			c.Favorite = req.Favorite
			c.UpdatedAt = now
			ds.state.Connections[i] = c
			return c, false, ds.saveStateLocked()
		}
		return ConnectionMeta{}, false, errors.New("connection not found")
	}
	c := ConnectionMeta{
		ID:           uuid.NewString(),
		GroupID:      req.GroupID,
		Name:         req.Name,
		Driver:       normalizeDriver(req.Driver),
		Host:         req.Host,
		Port:         req.Port,
		User:         req.User,
		DefaultDB:    req.DefaultDB,
		SSLMode:      fallback(req.SSLMode, "disable"),
		SSHTunnel:    req.SSHTunnel,
		Tags:         req.Tags,
		ReadOnlyFlag: req.ReadOnlyFlag,
		Favorite:     req.Favorite,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	ds.state.Connections = append(ds.state.Connections, c)
	return c, true, ds.saveStateLocked()
}

func (ds *DataStore) DeleteConnection(connectionID string) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	next := make([]ConnectionMeta, 0, len(ds.state.Connections))
	found := false
	for _, c := range ds.state.Connections {
		if c.ID == connectionID {
			found = true
			continue
		}
		next = append(next, c)
	}
	if !found {
		return errors.New("connection not found")
	}
	ds.state.Connections = next
	delete(ds.vault.Secrets, connectionID)
	if err := ds.saveStateLocked(); err != nil {
		return err
	}
	return ds.saveVaultLocked()
}

func (ds *DataStore) UpdateConnectionHealth(connectionID string, ok bool, errText string) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	now := time.Now()
	for i := range ds.state.Connections {
		if ds.state.Connections[i].ID == connectionID {
			ds.state.Connections[i].LastHealthCheckAt = &now
			ds.state.Connections[i].LastHealthCheckOK = ok
			ds.state.Connections[i].LastHealthCheckError = errText
			ds.state.Connections[i].UpdatedAt = now
			return ds.saveStateLocked()
		}
	}
	return errors.New("connection not found")
}

func (ds *DataStore) MarkGroupOpened(groupID string) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	next := []string{groupID}
	for _, id := range ds.state.RecentGroupIDs {
		if id != groupID {
			next = append(next, id)
		}
		if len(next) >= 20 {
			break
		}
	}
	ds.state.RecentGroupIDs = next
	return ds.saveStateLocked()
}

func (ds *DataStore) ListRecentGroupIDs() []string {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	out := make([]string, len(ds.state.RecentGroupIDs))
	copy(out, ds.state.RecentGroupIDs)
	return out
}

func (ds *DataStore) SaveSession(req SaveStudioSessionRequest) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.state.Sessions[req.GroupID] = StudioSessionSnapshot{
		GroupID:            req.GroupID,
		ActiveConnectionID: req.ActiveConnectionID,
		Tabs:               req.Tabs,
		UpdatedAt:          time.Now(),
	}
	return ds.saveStateLocked()
}

func (ds *DataStore) GetSession(groupID string) (StudioSessionSnapshot, bool) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	s, ok := ds.state.Sessions[groupID]
	return s, ok
}

func (ds *DataStore) AddTask(task BackgroundTask) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	ds.state.Tasks = append([]BackgroundTask{task}, ds.state.Tasks...)
	if len(ds.state.Tasks) > 200 {
		ds.state.Tasks = ds.state.Tasks[:200]
	}
	return ds.saveStateLocked()
}

func (ds *DataStore) ListTasks() []BackgroundTask {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	out := make([]BackgroundTask, len(ds.state.Tasks))
	copy(out, ds.state.Tasks)
	return out
}

func (ds *DataStore) ReadVault() vaultState {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	copyVault := ds.vault
	copyVault.Secrets = make(map[string]string, len(ds.vault.Secrets))
	for k, v := range ds.vault.Secrets {
		copyVault.Secrets[k] = v
	}
	return copyVault
}

func (ds *DataStore) UpdateVault(mutator func(v *vaultState) error) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if err := mutator(&ds.vault); err != nil {
		return err
	}
	return ds.saveVaultLocked()
}

func fallback(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func (ds *DataStore) GetConfigDir() string {
	return ds.configDir
}

func normalizeDriver(driver string) string {
	switch driver {
	case "postgres", "postgresql":
		return "postgres"
	default:
		return "mysql"
	}
}
