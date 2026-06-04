package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	store, err := NewDataStore("TableFlux")
	if err != nil {
		log.Fatal(err)
	}
	secretSvc := NewSecretService(store)
	workspaceSvc := NewWorkspaceService(store, secretSvc)
	dbSvc := NewDatabaseService(store, secretSvc)
	studioSvc := NewStudioWindowService(store)
	taskSvc := NewTaskService(store)
	settingsSvc, err := NewSettingsService(store.GetConfigDir())
	if err != nil {
		log.Fatal(err)
	}
	aiSvc := NewAIService(settingsSvc, dbSvc)

	app := application.New(application.Options{
		Name:        "TableFlux",
		Description: "TableFlux desktop database client",
		Services: []application.Service{
			application.NewService(secretSvc),
			application.NewService(workspaceSvc),
			application.NewService(dbSvc),
			application.NewService(studioSvc),
			application.NewService(taskSvc),
			application.NewService(aiSvc),
			application.NewService(settingsSvc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	mainWin := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "TableFlux",
		Width:            920,
		Height:           620,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: application.NewRGB(11, 17, 26),
		URL:              "/",
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
	})

	// 迁移进行中时：阻止关闭窗口，改为隐藏；无迁移时正常关闭
	mainWin.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if dbSvc.HasRunningMigration() {
			e.Cancel()
			mainWin.Hide()
		}
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
