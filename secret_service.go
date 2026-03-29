package main

import "errors"

type SecretService struct {
	store *DataStore
}

func NewSecretService(store *DataStore) *SecretService {
	return &SecretService{store: store}
}

func (s *SecretService) ServiceName() string {
	return "SecretService"
}

func (s *SecretService) GetVaultStatus() VaultStatus {
	return VaultStatus{HasMasterPassword: false, Unlocked: true}
}

func (s *SecretService) SetMasterPassword(_ string) error {
	return nil
}

func (s *SecretService) UnlockVault(_ string) error {
	return nil
}

func (s *SecretService) LockVault() {}

func (s *SecretService) ChangeMasterPassword(_, _ string) error {
	return nil
}

func (s *SecretService) SetConnectionSecret(connectionID, secret string) error {
	return s.store.UpdateVault(func(v *vaultState) error {
		if v.Secrets == nil {
			v.Secrets = map[string]string{}
		}
		v.Secrets[connectionID] = secret
		v.Salt = ""
		v.PasswordHash = ""
		return nil
	})
}

func (s *SecretService) GetConnectionSecret(connectionID string) (string, error) {
	v := s.store.ReadVault()
	secret, ok := v.Secrets[connectionID]
	if !ok {
		return "", errors.New("connection secret not found")
	}
	return secret, nil
}

func (s *SecretService) DeleteConnectionSecret(connectionID string) error {
	return s.store.UpdateVault(func(v *vaultState) error {
		delete(v.Secrets, connectionID)
		return nil
	})
}

func (s *SecretService) RequireUnlocked() error {
	return nil
}
