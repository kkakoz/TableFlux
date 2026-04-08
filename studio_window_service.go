package main

import (
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type StudioWindowService struct {
	store *DataStore
}

func NewStudioWindowService(store *DataStore) *StudioWindowService {
	return &StudioWindowService{store: store}
}

func (s *StudioWindowService) ServiceName() string {
	return "StudioWindow"
}

func (s *StudioWindowService) OpenGroupWindow(groupID string) error {
	if groupID == "" {
		return fmt.Errorf("groupId is required")
	}
	if err := s.store.MarkGroupOpened(groupID); err != nil {
		return err
	}
	app := application.Get()
	if app == nil {
		return fmt.Errorf("app is not initialized")
	}
	name := "studio-" + groupID
	if w, ok := app.Window.GetByName(name); ok {
		w.Focus()
		return nil
	}
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             name,
		Title:            "TableFlux Studio",
		Width:            1440,
		Height:           900,
		MinWidth:         1024,
		MinHeight:        640,
		BackgroundColour: application.NewRGB(10, 16, 24),
		URL:              "/?studio=1&groupId=" + groupID,
	})
	return nil
}

// FocusMainWindow 聚焦连接管理主窗口（名称为 main）。
func (s *StudioWindowService) FocusMainWindow() error {
	app := application.Get()
	if app == nil {
		return fmt.Errorf("app is not initialized")
	}
	if w, ok := app.Window.GetByName("main"); ok {
		w.Focus()
		return nil
	}
	return fmt.Errorf("main window not found")
}
