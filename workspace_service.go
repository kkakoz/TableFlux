package main

import (
	"database/sql"
	"errors"
	"fmt"
)

type WorkspaceService struct {
	store   *DataStore
	secrets *SecretService
}

func NewWorkspaceService(store *DataStore, secrets *SecretService) *WorkspaceService {
	return &WorkspaceService{store: store, secrets: secrets}
}

func (s *WorkspaceService) ServiceName() string {
	return "WorkspaceService"
}

func (s *WorkspaceService) ListGroups() []WorkspaceGroup {
	return s.store.ListGroups()
}

func (s *WorkspaceService) CreateGroup(req GroupCreateRequest) (WorkspaceGroup, error) {
	if req.Name == "" {
		return WorkspaceGroup{}, errors.New("group name is required")
	}
	return s.store.CreateGroup(req)
}

func (s *WorkspaceService) UpdateGroup(groupID string, req GroupUpdateRequest) (WorkspaceGroup, error) {
	return s.store.UpdateGroup(groupID, req)
}

func (s *WorkspaceService) DeleteGroup(groupID string) error {
	return s.store.DeleteGroup(groupID)
}

func (s *WorkspaceService) ReorderGroups(req GroupReorderRequest) error {
	return s.store.ReorderGroups(req.OrderedIDs)
}

func (s *WorkspaceService) ListGroupConnections(groupID string) []ConnectionMeta {
	return s.store.ListConnections(groupID)
}

func (s *WorkspaceService) CreateConnection(req ConnectionUpsertRequest) (ConnectionMeta, error) {
	return s.upsertConnection("", req)
}

func (s *WorkspaceService) UpdateConnection(connectionID string, req ConnectionUpsertRequest) (ConnectionMeta, error) {
	return s.upsertConnection(connectionID, req)
}

func (s *WorkspaceService) upsertConnection(connectionID string, req ConnectionUpsertRequest) (ConnectionMeta, error) {
	if req.GroupID == "" {
		return ConnectionMeta{}, errors.New("groupId is required")
	}
	if req.Name == "" {
		return ConnectionMeta{}, errors.New("connection name is required")
	}
	if req.Host == "" {
		return ConnectionMeta{}, errors.New("host is required")
	}
	if req.User == "" {
		return ConnectionMeta{}, errors.New("user is required")
	}
	if req.Port == 0 {
		if normalizeDriver(req.Driver) == "postgres" {
			req.Port = 5432
		} else {
			req.Port = 3306
		}
	}
	conn, _, err := s.store.PutConnection(connectionID, req)
	if err != nil {
		return ConnectionMeta{}, err
	}
	if req.Password != "" {
		if err := s.secrets.SetConnectionSecret(conn.ID, req.Password); err != nil {
			return ConnectionMeta{}, err
		}
	}
	return conn, nil
}

func (s *WorkspaceService) DeleteConnection(connectionID string) error {
	if err := s.store.DeleteConnection(connectionID); err != nil {
		return err
	}
	return s.secrets.DeleteConnectionSecret(connectionID)
}

func (s *WorkspaceService) SetConnectionFavorite(connectionID string, favorite bool) (ConnectionMeta, error) {
	conn, ok := s.store.GetConnection(connectionID)
	if !ok {
		return ConnectionMeta{}, errors.New("connection not found")
	}
	connReq := ConnectionUpsertRequest{
		GroupID:      conn.GroupID,
		Name:         conn.Name,
		Driver:       conn.Driver,
		Host:         conn.Host,
		Port:         conn.Port,
		User:         conn.User,
		DefaultDB:    conn.DefaultDB,
		SSLMode:      conn.SSLMode,
		SSHTunnel:    conn.SSHTunnel,
		Tags:         conn.Tags,
		ReadOnlyFlag: conn.ReadOnlyFlag,
		Favorite:     favorite,
	}
	return s.upsertConnection(connectionID, connReq)
}

func (s *WorkspaceService) SetConnectionTags(connectionID string, tags []string) (ConnectionMeta, error) {
	conn, ok := s.store.GetConnection(connectionID)
	if !ok {
		return ConnectionMeta{}, errors.New("connection not found")
	}
	connReq := ConnectionUpsertRequest{
		GroupID:      conn.GroupID,
		Name:         conn.Name,
		Driver:       conn.Driver,
		Host:         conn.Host,
		Port:         conn.Port,
		User:         conn.User,
		DefaultDB:    conn.DefaultDB,
		SSLMode:      conn.SSLMode,
		SSHTunnel:    conn.SSHTunnel,
		Tags:         tags,
		ReadOnlyFlag: conn.ReadOnlyFlag,
		Favorite:     conn.Favorite,
	}
	return s.upsertConnection(connectionID, connReq)
}

func (s *WorkspaceService) TestConnection(connectionID string) (string, error) {
	conn, ok := s.store.GetConnection(connectionID)
	if !ok {
		return "", errors.New("connection not found")
	}
	password, err := s.secrets.GetConnectionSecret(connectionID)
	if err != nil {
		return "", err
	}
	dsn := buildDSN(conn, password, conn.DefaultDB)
	driverName := sqlDriverName(conn.Driver)
	db, err := sql.Open(driverName, dsn)
	if err != nil {
		s.store.UpdateConnectionHealth(connectionID, false, err.Error())
		return "", err
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		s.store.UpdateConnectionHealth(connectionID, false, err.Error())
		return "", err
	}
	s.store.UpdateConnectionHealth(connectionID, true, "")
	return fmt.Sprintf("%s connection is healthy", conn.Name), nil
}

func (s *WorkspaceService) MarkGroupOpened(groupID string) error {
	return s.store.MarkGroupOpened(groupID)
}

func (s *WorkspaceService) ListRecentGroupIDs() []string {
	return s.store.ListRecentGroupIDs()
}

func (s *WorkspaceService) SaveStudioSession(req SaveStudioSessionRequest) error {
	if req.GroupID == "" {
		return errors.New("groupId is required")
	}
	return s.store.SaveSession(req)
}

func (s *WorkspaceService) GetStudioSession(groupID string) (StudioSessionSnapshot, error) {
	if s, ok := s.store.GetSession(groupID); ok {
		return s, nil
	}
	return StudioSessionSnapshot{GroupID: groupID, Tabs: []StudioTabSnapshot{}}, nil
}
