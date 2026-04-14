package main

import (
	"fmt"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
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
		// 工作台已存在，确保主窗口隐藏并聚焦工作台
		if mainWin, ok2 := app.Window.GetByName("main"); ok2 {
			mainWin.Hide()
		}
		w.Fullscreen()
		w.Focus()
		return nil
	}

	// 用分组名作窗口标题
	groupName := groupID
	if group, ok := s.store.GetGroup(groupID); ok {
		groupName = group.Name
	}

	w := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             name,
		Title:            groupName,
		Width:            1440,
		Height:           900,
		MinWidth:         1024,
		MinHeight:        640,
		StartState:       application.WindowStateFullscreen,
		BackgroundColour: application.NewRGB(10, 16, 24),
		URL:              "/?studio=1&groupId=" + groupID,
	})

	// 隐藏连接管理主窗口
	if mainWin, ok := app.Window.GetByName("main"); ok {
		mainWin.Hide()
	}

	// 工作台关闭时，若已无其他工作台窗口则重新显示连接管理界面
	w.OnWindowEvent(events.Common.WindowClosing, func(_ *application.WindowEvent) {
		hasOtherStudio := false
		for _, win := range app.Window.GetAll() {
			if win.Name() != name && strings.HasPrefix(win.Name(), "studio-") {
				hasOtherStudio = true
				break
			}
		}
		if !hasOtherStudio {
			if mainWin, ok := app.Window.GetByName("main"); ok {
				mainWin.Show()
				mainWin.Focus()
			}
		}
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
